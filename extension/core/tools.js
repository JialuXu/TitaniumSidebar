// core/tools.js —— 感知与动作工具的定义与分发（平台无关层）
//
// 工具的“执行”由外壳注入的 provider 承担（executeScript/captureVisibleTab/tabs
// 等 chrome.* 接线都在外壳），core 只负责：定义 OpenAI 工具协议、解析参数、
// 调 provider、把结果序列化成发给模型的文本，并统一过 provider.mask 脱敏。
//
// provider 接口：
//   —— 感知 ——
//   searchInPage({ query, maxResults })  → searchPage 返回值
//   listElements({ scope, query })       → { elements, total, viewport?, stats? }
//   highlight({ ref })                   → highlightElement 返回值
//   captureScreenshot()                  → { dataUrl, markCount, viewport }
//   mask(text)                           → string（未开脱敏时为恒等函数）
//   —— 页内动作（注入 performAction）——
//   act(payload)                         → { result: performAction 返回值, change: 页面变化|null }
//   —— 浏览器级动作（chrome.tabs）——
//   navigate({ url }) / goBack() / refresh()        → 页面变化
//   openTab({ url }) / switchTab({ tabId })         → 页面变化
//   closeTab({ tabId })                             → { remaining, change }
//   listTabs()                                      → [{ id, title, url, active, isWork }]
//
// provider 方法失败时 throw Error（message 为中文，将直接作为工具结果给模型）。
// 「页面变化」形状见 core/format.js 的 formatPageChange。

import { formatElements, formatSearchResults, formatPageStatus, formatPageChange, formatTabs, BUDGETS } from './format.js';

/** 纯感知模式下每个用户回合的最大工具轮数，超过后强制模型直接作答 */
export const MAX_TOOL_ROUNDS = 5;

/**
 * 开启页面操作后的最大轮数。一次表单填写通常是
 * list_elements(1) + input_text(3~5) + click(1) + 验证(1~2) ≈ 8~10 轮，
 * 5 轮必然中断；15 轮既够用，也是成本与失控的上限。
 */
export const MAX_ACTION_ROUNDS = 15;

/**
 * 有真实副作用的工具名：重放它们会再次改变页面或浏览器状态，
 * 外壳据此在「重新生成」前要求用户二次确认。
 * scroll_page / list_tabs 不在其中——它们可逆且不改动任何页面数据。
 */
export const WRITE_TOOL_NAMES = new Set([
  'click_element', 'input_text', 'select_option', 'press_key',
  'navigate', 'go_back', 'refresh', 'open_tab', 'switch_tab', 'close_tab',
]);

/** 动作工具允许的按键（与 core/actions.js 的 KEYS 表保持一致） */
const ALLOWED_KEYS = [
  'Enter', 'Tab', 'Escape', 'Backspace', 'Delete',
  'ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight',
  'PageUp', 'PageDown', 'Home', 'End',
];

function fn(name, description, properties, required) {
  return {
    type: 'function',
    function: {
      name,
      description,
      parameters: { type: 'object', properties: properties || {}, ...(required ? { required } : {}) },
    },
  };
}

/**
 * 构建 OpenAI 工具定义列表，按能力分三组注册。
 * @param {{ vision?: boolean, actions?: boolean }} [caps]
 *   vision=false 时不含 capture_screenshot；actions=false 时不含任何会改变页面的工具。
 */
export function buildToolDefs({ vision = false, actions = false } = {}) {
  /* ---------- 感知组（恒定可用，全部只读） ---------- */
  const defs = [
    fn('find_in_page',
      '在当前网页的完整文本中搜索关键词。<页面内容> 可能因过长被截断，' +
      '其中找不到的信息用本工具查找。返回每处匹配的上下文片段。',
      {
        query: { type: 'string', description: '关键词或短语，字面匹配、大小写不敏感，不支持正则' },
        max_results: { type: 'integer', minimum: 1, maximum: 10, description: '最多返回几处匹配，默认 5' },
      },
      ['query']),

    fn('list_elements',
      '列出当前网页的可交互元素（链接、按钮、输入框等），每项带编号 ref。' +
      '用于了解页面有哪些操作入口，并为高亮与各类操作提供编号。' +
      '带 * 前缀的元素是上次操作后新出现的。页面跳转或大幅变化后应重新调用。',
      {
        scope: {
          type: 'string', enum: ['viewport', 'page'],
          description: 'viewport=仅当前可见区域（默认），page=整个页面',
        },
        query: { type: 'string', description: '可选，按元素名称包含关系过滤' },
      }),

    fn('highlight_element',
      '在页面上用高亮框短暂标出指定编号的元素（必要时自动滚动到它），' +
      '帮用户在页面上找到它。只做视觉提示，不点击、不改动页面。',
      { ref: { type: 'integer', description: 'list_elements 或截图标注中的元素编号' } },
      ['ref']),

    fn('extract_table',
      '把页面中第 N 个表格完整转成 Markdown 返回，不受 <页面内容> 12000 字截断的限制。' +
      '表格序号见 <页面结构> 中标注的 #N。适合需要逐行核对数据的场景。',
      {
        table_index: { type: 'integer', minimum: 1, description: '表格序号，从 1 开始，对应页面结构里的 #N' },
      },
      ['table_index']),

    fn('get_element_html',
      '返回指定编号元素的精简 HTML（已去掉脚本、样式与无关属性）。' +
      '用于理解自定义组件的内部结构——例如某个下拉/日期控件到底由哪些子元素组成。',
      {
        ref: { type: 'integer', description: 'list_elements 中的元素编号' },
        max_len: { type: 'integer', description: '返回的最大字符数，默认 4000' },
      },
      ['ref']),
  ];

  /* ---------- 视觉组 ---------- */
  if (vision) {
    defs.push(fn('capture_screenshot',
      '截取当前浏览器可见视口的截图，图上自动用编号框标注可交互元素（编号即 ref）。' +
      '用于理解布局、图表、图片等文字无法表达的内容。注意：截图内容不经过脱敏。'));
  }

  /* ---------- 动作组（用户在设置中开启「允许页面操作」后才注册） ---------- */
  if (actions) {
    defs.push(
      fn('click_element',
        '点击指定编号的元素（按钮、链接、勾选框等）。点击前会自动滚动到它。' +
        '执行后返回页面是否跳转、以及新出现了哪些可交互元素。',
        { ref: { type: 'integer', description: 'list_elements 中的元素编号' } },
        ['ref']),

      fn('input_text',
        '在指定编号的输入框中填入文本，会先清空原有内容（整体替换，不是追加）。' +
        '支持 React/Vue 等框架的受控组件。填完后通常需要 press_key 回车或 click_element 提交。',
        {
          ref: { type: 'integer', description: '输入框的元素编号' },
          text: { type: 'string', description: '要填入的完整文本' },
        },
        ['ref', 'text']),

      fn('select_option',
        '在指定编号的下拉框（原生 <select>）中选择一项，按选项文本匹配。' +
        '若目标不是原生下拉而是自定义组件，改用 click_element 展开后再点选项。',
        {
          ref: { type: 'integer', description: '下拉框的元素编号' },
          option: { type: 'string', description: '选项的显示文本（也可传 value）' },
        },
        ['ref', 'option']),

      fn('press_key',
        '按下一个功能键。不带 ref 时作用于当前焦点元素，带 ref 时先聚焦该元素再按。' +
        '常用于输入后回车提交、Escape 关闭弹层、方向键在下拉候选中移动。',
        {
          key: { type: 'string', enum: ALLOWED_KEYS, description: '按键名' },
          ref: { type: 'integer', description: '可选，先聚焦到该编号的元素' },
        },
        ['key']),

      fn('scroll_page',
        '滚动页面。用于让视口外的内容进入可见区域（列元素时 scope:viewport 只返回可见部分）。' +
        '注意：查找页面文字用 find_in_page 更快，不需要靠滚动去翻。',
        {
          direction: { type: 'string', enum: ['up', 'down', 'top', 'bottom'], description: '滚动方向' },
          pages: { type: 'number', description: '滚动几屏，默认 1（direction 为 top/bottom 时忽略）' },
        },
        ['direction']),

      fn('navigate',
        '让当前工作标签页跳转到指定网址（仅支持 http/https）。跳转后元素编号全部重置。',
        { url: { type: 'string', description: '完整网址，需以 http:// 或 https:// 开头' } },
        ['url']),

      fn('go_back', '在当前工作标签页执行浏览器后退。'),

      fn('refresh', '重新加载当前工作标签页。刷新后元素编号全部重置。'),

      fn('open_tab',
        '在新标签页中打开指定网址，并把它设为当前工作标签页（后续操作都作用于它）。',
        { url: { type: 'string', description: '完整网址，需以 http:// 或 https:// 开头' } },
        ['url']),

      fn('switch_tab',
        '切换到指定的标签页，并把它设为当前工作标签页。tab_id 来自 list_tabs。',
        { tab_id: { type: 'integer', description: 'list_tabs 返回的 tab_id' } },
        ['tab_id']),

      fn('close_tab',
        '关闭指定标签页；不传 tab_id 则关闭当前工作标签页。关闭后会自动切换到另一个可用标签页。',
        { tab_id: { type: 'integer', description: '可选，list_tabs 返回的 tab_id' } }),

      fn('list_tabs', '列出当前窗口所有标签页的编号、标题与网址，并标明哪个是当前工作标签页。')
    );
  }

  return defs;
}

/* ========== 失败原因 → 中文文案（外壳与模型都读得懂） ========== */
function describeFailure(result, args) {
  const ref = args && args.ref;
  const nm = result && result.name ? ` "${result.name}"` : '';
  switch (result && result.reason) {
    case 'stale':
      return '元素编号已过期（页面已刷新或跳转），请先调用 list_elements 获取最新编号。';
    case 'bad-ref':
      return `没有编号为 ${ref} 的元素，请用 list_elements 确认编号。`;
    case 'gone':
      return `元素 [${ref}] 已从页面上消失，请重新调用 list_elements。`;
    case 'hidden':
      return `元素 [${ref}] 当前不可见（可能在折叠区域内），请先展开或滚动到它再操作。`;
    case 'disabled':
      return `元素 [${ref}]${nm} 处于禁用状态，无法操作；通常需要先满足页面的前置条件。`;
    case 'not-editable':
      return `元素 [${ref}]${nm} 不是可输入的控件，请确认编号是否正确。`;
    case 'not-select':
      return `元素 [${ref}]${nm} 不是原生下拉框；若是自定义下拉组件，请用 click_element 展开后再点具体选项。`;
    case 'option-not-found': {
      const list = (result.options || []).map((o) => `「${o}」`).join('、');
      return `下拉框 [${ref}]${nm} 中没有匹配的选项。可选项共 ${result.total} 个：${list}。请用其中之一重试。`;
    }
    case 'bad-key':
      return `不支持的按键。可用按键：${ALLOWED_KEYS.join(' / ')}。`;
    case 'bad-table-index':
      return `页面中没有这个序号的表格，当前共有 ${result.total} 个表格。`;
    case 'no-body':
      return '页面尚未加载完成，请稍后重试。';
    default:
      return '动作执行失败，请换一种方式或先重新调用 list_elements 确认页面状态。';
  }
}

/** 动作结果尾部统一附上页面变化摘要 */
function withChange(text, change) {
  const tail = formatPageChange(change);
  return tail ? `${text}\n${tail}` : text;
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

  // 页内动作的公共壳：失败映射中文，成功拼「结果描述 + 页面变化摘要」
  const doAct = async (payload, onSuccess, uiData) => {
    const { result, change } = await provider.act(payload);
    meta.data = { ...(uiData || {}) };
    if (!result || !result.ok) {
      meta.data.reason = result && result.reason;
      return reply(provider.mask(describeFailure(result, args)));
    }
    meta.ok = true;
    meta.data.navigated = Boolean(change && change.navigated);
    Object.assign(meta.data, onSuccess.data ? onSuccess.data(result) : {});
    return reply(provider.mask(withChange(onSuccess.text(result), change)));
  };

  try {
    switch (call.name) {
      /* ================= 感知组 ================= */
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
        const header = `${scopeNote}${query ? `，按「${query}」过滤` : ''}，共 ${res.total} 个）`;
        const status = formatPageStatus(res.viewport, res.stats);
        const legend = res.elements.some((e) => e.isNew) ? '带 * 的元素是上次操作后新出现的。' : '';
        const head = [status, legend, header].filter(Boolean).join('\n');
        // query 过滤 = 模型在钻取具体某几个元素，此时逐项列出（不折叠同构组）
        return reply(provider.mask(head + '\n' + formatElements(res.elements, { total: res.total, collapse: !query })));
      }

      case 'highlight_element': {
        const ref = Number(args.ref);
        const res = await provider.highlight({ ref });
        if (res && res.ok) {
          meta.ok = true;
          meta.data = { ref, name: res.name };
          return reply(provider.mask(`已在页面上高亮元素 [${ref}]${res.name ? ` "${res.name}"` : ''}，数秒后自动消失。`));
        }
        meta.data = { ref, reason: res && res.reason };
        return reply(provider.mask(describeFailure(res, args)));
      }

      case 'extract_table': {
        const idx = Number(args.table_index);
        const { result } = await provider.act({ action: 'extract_table', tableIndex: idx, maxLen: BUDGETS.table });
        if (!result || !result.ok) {
          meta.data = { tableIndex: idx, reason: result && result.reason };
          return reply(provider.mask(describeFailure(result, args)));
        }
        meta.ok = true;
        meta.data = { tableIndex: idx, rowCount: result.rowCount, colCount: result.colCount };
        const head = `页面中第 ${idx} 个表格（共 ${result.total} 个），${result.rowCount} 行 × ${result.colCount} 列：`;
        return reply(provider.mask(head + '\n' + (result.data || '（该表格没有可解析的表头或内容）')));
      }

      case 'get_element_html': {
        const ref = Number(args.ref);
        const maxLen = Math.min(Number(args.max_len) || BUDGETS.html, 20000);
        const { result } = await provider.act({ action: 'get_html', ref, maxLen });
        if (!result || !result.ok) {
          meta.data = { ref, reason: result && result.reason };
          return reply(provider.mask(describeFailure(result, args)));
        }
        meta.ok = true;
        meta.data = { ref, name: result.name };
        return reply(provider.mask(`元素 [${ref}]${result.name ? ` "${result.name}"` : ''} 的结构：\n${result.data}`));
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

      /* ================= 动作组：页内 ================= */
      case 'click_element': {
        const ref = Number(args.ref);
        return await doAct({ action: 'click', ref }, {
          text: (r) => {
            const checked = typeof r.checked === 'boolean' ? `，当前${r.checked ? '已勾选' : '未勾选'}` : '';
            return `已点击元素 [${ref}]${r.name ? ` "${r.name}"` : ''}${checked}。`;
          },
          data: (r) => ({ ref, name: r.name }),
        }, { ref });
      }

      case 'input_text': {
        const ref = Number(args.ref);
        const text = String(args.text == null ? '' : args.text);
        return await doAct({ action: 'input', ref, text }, {
          text: (r) => `已在 [${ref}]${r.name ? ` "${r.name}"` : ''} 中填入：${r.value}`,
          data: (r) => ({ ref, name: r.name }),
        }, { ref, text });
      }

      case 'select_option': {
        const ref = Number(args.ref);
        const option = String(args.option == null ? '' : args.option);
        return await doAct({ action: 'select', ref, option }, {
          text: (r) => `已在下拉框 [${ref}]${r.name ? ` "${r.name}"` : ''} 中选择「${r.value}」。`,
          data: (r) => ({ ref, name: r.name, value: r.value }),
        }, { ref, option });
      }

      case 'press_key': {
        const key = String(args.key || '');
        const ref = args.ref == null ? null : Number(args.ref);
        return await doAct({ action: 'key', key, ...(ref == null ? {} : { ref }) }, {
          text: (r) => {
            const extra = r.submitted ? '，已提交所属表单' : (r.movedTo ? `，焦点移到「${r.movedTo}」` : '');
            return `已按下 ${r.key}${r.target ? `（作用于 "${r.target}"）` : ''}${extra}。`;
          },
          data: (r) => ({ key: r.key, submitted: r.submitted }),
        }, { key, ref });
      }

      case 'scroll_page': {
        const direction = ['up', 'down', 'top', 'bottom'].includes(args.direction) ? args.direction : 'down';
        const pages = Number(args.pages) || 1;
        return await doAct({ action: 'scroll', direction, pages }, {
          text: (r) => {
            const label = { up: '向上', down: '向下', top: '回到顶部', bottom: '到达底部' }[r.direction];
            return `已${label}滚动。\n${formatPageStatus(r.viewport, null)}`;
          },
          data: (r) => ({ direction: r.direction }),
        }, { direction, pages });
      }

      /* ================= 动作组：浏览器级 ================= */
      case 'navigate': {
        const url = String(args.url || '').trim();
        const change = await provider.navigate({ url });
        meta.ok = true;
        meta.data = { url, title: change && change.title, navigated: true };
        return reply(provider.mask(withChange(`已跳转到 ${url}。`, change)));
      }

      case 'go_back': {
        const change = await provider.goBack();
        meta.ok = true;
        meta.data = { title: change && change.title, navigated: true };
        return reply(provider.mask(withChange('已执行后退。', change)));
      }

      case 'refresh': {
        const change = await provider.refresh();
        meta.ok = true;
        meta.data = { title: change && change.title, navigated: true };
        return reply(provider.mask(withChange('已重新加载页面。', change)));
      }

      case 'open_tab': {
        const url = String(args.url || '').trim();
        const change = await provider.openTab({ url });
        meta.ok = true;
        meta.data = { url, title: change && change.title, navigated: true };
        return reply(provider.mask(withChange(`已在新标签页中打开 ${url}，后续操作将作用于它。`, change)));
      }

      case 'switch_tab': {
        const tabId = Number(args.tab_id);
        const change = await provider.switchTab({ tabId });
        meta.ok = true;
        meta.data = { tabId, title: change && change.title, navigated: true };
        return reply(provider.mask(withChange(`已切换到标签页 ${tabId}，后续操作将作用于它。`, change)));
      }

      case 'close_tab': {
        const tabId = args.tab_id == null ? null : Number(args.tab_id);
        const res = await provider.closeTab({ tabId });
        meta.ok = true;
        meta.data = { tabId, navigated: Boolean(res.change && res.change.navigated) };
        const head = `已关闭标签页${tabId == null ? '（当前工作页）' : ` ${tabId}`}，还剩 ${res.remaining} 个。`;
        return reply(provider.mask(withChange(head, res.change)));
      }

      case 'list_tabs': {
        const tabs = await provider.listTabs();
        meta.ok = true;
        meta.data = { count: tabs.length };
        return reply(provider.mask(formatTabs(tabs)));
      }

      default:
        return reply(`未知工具 ${call.name}，可用工具以本次请求的 tools 定义为准。`);
    }
  } catch (err) {
    // provider 抛出的中文错误（标签页切换、注入失败、截图失败等）直接作为工具结果
    return reply((err && err.message) || '工具执行失败。');
  }
}
