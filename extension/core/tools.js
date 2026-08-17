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
// provider 方法失败时 throw Error（message 已按当前语言取词，直接作为工具结果给模型）。
// 「页面变化」形状见 core/format.js 的 formatPageChange。
//
// 工具描述与工具结果都随界面语言切换（文案见 core/i18n.js）：模型看到的说明必须与
// 用户看到的界面同语言，否则英文界面下会得到中文的工具反馈。

import { formatElements, formatSearchResults, formatPageStatus, formatPageChange, formatTabs, BUDGETS } from './format.js';
import { t, q } from './i18n.js';

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
    fn('find_in_page', t('tool.find.d'),
      {
        query: { type: 'string', description: t('tool.find.query') },
        max_results: { type: 'integer', minimum: 1, maximum: 10, description: t('tool.find.max') },
      },
      ['query']),

    fn('list_elements', t('tool.list.d'),
      {
        scope: { type: 'string', enum: ['viewport', 'page'], description: t('tool.list.scope') },
        query: { type: 'string', description: t('tool.list.query') },
      }),

    fn('highlight_element', t('tool.highlight.d'),
      { ref: { type: 'integer', description: t('tool.highlight.ref') } },
      ['ref']),

    fn('extract_table', t('tool.table.d'),
      { table_index: { type: 'integer', minimum: 1, description: t('tool.table.index') } },
      ['table_index']),

    fn('get_element_html', t('tool.html.d'),
      {
        ref: { type: 'integer', description: t('tool.html.ref') },
        max_len: { type: 'integer', description: t('tool.html.max') },
      },
      ['ref']),
  ];

  /* ---------- 视觉组 ---------- */
  if (vision) {
    defs.push(fn('capture_screenshot', t('tool.shot.d')));
  }

  /* ---------- 动作组（用户在设置中开启「允许页面操作」后才注册） ---------- */
  if (actions) {
    defs.push(
      fn('click_element', t('tool.click.d'),
        { ref: { type: 'integer', description: t('tool.click.ref') } },
        ['ref']),

      fn('input_text', t('tool.input.d'),
        {
          ref: { type: 'integer', description: t('tool.input.ref') },
          text: { type: 'string', description: t('tool.input.text') },
        },
        ['ref', 'text']),

      fn('select_option', t('tool.select.d'),
        {
          ref: { type: 'integer', description: t('tool.select.ref') },
          option: { type: 'string', description: t('tool.select.option') },
        },
        ['ref', 'option']),

      fn('press_key', t('tool.key.d'),
        {
          key: { type: 'string', enum: ALLOWED_KEYS, description: t('tool.key.key') },
          ref: { type: 'integer', description: t('tool.key.ref') },
        },
        ['key']),

      fn('scroll_page', t('tool.scroll.d'),
        {
          direction: { type: 'string', enum: ['up', 'down', 'top', 'bottom'], description: t('tool.scroll.direction') },
          pages: { type: 'number', description: t('tool.scroll.pages') },
        },
        ['direction']),

      fn('navigate', t('tool.navigate.d'),
        { url: { type: 'string', description: t('tool.navigate.url') } },
        ['url']),

      fn('go_back', t('tool.back.d')),

      fn('refresh', t('tool.refresh.d')),

      fn('open_tab', t('tool.openTab.d'),
        { url: { type: 'string', description: t('tool.openTab.url') } },
        ['url']),

      fn('switch_tab', t('tool.switchTab.d'),
        { tab_id: { type: 'integer', description: t('tool.switchTab.id') } },
        ['tab_id']),

      fn('close_tab', t('tool.closeTab.d'),
        { tab_id: { type: 'integer', description: t('tool.closeTab.id') } }),

      fn('list_tabs', t('tool.listTabs.d'))
    );
  }

  return defs;
}

/* ========== 失败原因 → 可读文案（外壳与模型都读得懂，随语言切换） ========== */
function describeFailure(result, args) {
  const ref = args && args.ref;
  const name = result && result.name ? ` "${result.name}"` : '';
  switch (result && result.reason) {
    case 'stale':
      return t('fail.stale');
    case 'bad-ref':
      return t('fail.badRef', { ref });
    case 'gone':
      return t('fail.gone', { ref });
    case 'hidden':
      return t('fail.hidden', { ref });
    case 'disabled':
      return t('fail.disabled', { ref, name });
    case 'not-editable':
      return t('fail.notEditable', { ref, name });
    case 'not-select':
      return t('fail.notSelect', { ref, name });
    case 'option-not-found': {
      const options = (result.options || []).map((o) => q(o)).join(t('fail.optionSep'));
      return t('fail.optionNotFound', { ref, name, total: result.total, options });
    }
    case 'bad-key':
      return t('fail.badKey', { keys: ALLOWED_KEYS.join(' / ') });
    case 'bad-table-index':
      return t('fail.badTableIndex', { total: result.total });
    case 'no-body':
      return t('fail.noBody');
    default:
      return t('fail.default');
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
    return reply(t('res.badJson'));
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
        if (!query) return reply(t('res.missingQuery'));
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
        const header = t('res.listHead', {
          scope: t(scope === 'viewport' ? 'res.scopeViewport' : 'res.scopePage'),
          filter: query ? t('res.listFilter', { query }) : '',
          total: res.total,
        });
        const status = formatPageStatus(res.viewport, res.stats);
        const legend = res.elements.some((e) => e.isNew) ? t('res.newLegend') : '';
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
          return reply(provider.mask(t('res.highlighted', { ref, name: res.name ? ` "${res.name}"` : '' })));
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
        const head = t('res.tableHead', {
          index: idx, total: result.total, rows: result.rowCount, cols: result.colCount,
        });
        return reply(provider.mask(head + '\n' + (result.data || t('res.tableEmpty'))));
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
        const head = t('res.htmlHead', { ref, name: result.name ? ` "${result.name}"` : '' });
        return reply(provider.mask(`${head}\n${result.data}`));
      }

      case 'capture_screenshot': {
        const shot = await provider.captureScreenshot();
        meta.ok = true;
        meta.data = { markCount: shot.markCount, w: shot.viewport.w, h: shot.viewport.h };
        return reply(
          t('res.shotDone', { w: shot.viewport.w, h: shot.viewport.h, count: shot.markCount }),
          {
            role: 'user',
            content: [
              { type: 'text', text: t('res.shotInject') },
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
            const checked = typeof r.checked === 'boolean' ? t(r.checked ? 'res.checkedOn' : 'res.checkedOff') : '';
            return t('res.clicked', { ref, name: r.name ? ` "${r.name}"` : '', checked });
          },
          data: (r) => ({ ref, name: r.name }),
        }, { ref });
      }

      case 'input_text': {
        const ref = Number(args.ref);
        const text = String(args.text == null ? '' : args.text);
        return await doAct({ action: 'input', ref, text }, {
          text: (r) => t('res.inputDone', { ref, name: r.name ? ` "${r.name}"` : '', value: r.value }),
          data: (r) => ({ ref, name: r.name }),
        }, { ref, text });
      }

      case 'select_option': {
        const ref = Number(args.ref);
        const option = String(args.option == null ? '' : args.option);
        return await doAct({ action: 'select', ref, option }, {
          text: (r) => t('res.selected', { ref, name: r.name ? ` "${r.name}"` : '', value: r.value }),
          data: (r) => ({ ref, name: r.name, value: r.value }),
        }, { ref, option });
      }

      case 'press_key': {
        const key = String(args.key || '');
        const ref = args.ref == null ? null : Number(args.ref);
        return await doAct({ action: 'key', key, ...(ref == null ? {} : { ref }) }, {
          text: (r) => {
            const extra = r.submitted
              ? t('res.keySubmitted')
              : (r.movedTo ? t('res.keyMoved', { name: r.movedTo }) : '');
            const target = r.target ? t('res.keyTarget', { name: r.target }) : '';
            return t('res.keyDone', { key: r.key, target, extra });
          },
          data: (r) => ({ key: r.key, submitted: r.submitted }),
        }, { key, ref });
      }

      case 'scroll_page': {
        const direction = ['up', 'down', 'top', 'bottom'].includes(args.direction) ? args.direction : 'down';
        const pages = Number(args.pages) || 1;
        return await doAct({ action: 'scroll', direction, pages }, {
          text: (r) => `${t('res.scrolled.' + r.direction)}\n${formatPageStatus(r.viewport, null)}`,
          data: (r) => ({ direction: r.direction }),
        }, { direction, pages });
      }

      /* ================= 动作组：浏览器级 ================= */
      case 'navigate': {
        const url = String(args.url || '').trim();
        const change = await provider.navigate({ url });
        meta.ok = true;
        meta.data = { url, title: change && change.title, navigated: true };
        return reply(provider.mask(withChange(t('res.navigated', { url }), change)));
      }

      case 'go_back': {
        const change = await provider.goBack();
        meta.ok = true;
        meta.data = { title: change && change.title, navigated: true };
        return reply(provider.mask(withChange(t('res.wentBack'), change)));
      }

      case 'refresh': {
        const change = await provider.refresh();
        meta.ok = true;
        meta.data = { title: change && change.title, navigated: true };
        return reply(provider.mask(withChange(t('res.refreshed'), change)));
      }

      case 'open_tab': {
        const url = String(args.url || '').trim();
        const change = await provider.openTab({ url });
        meta.ok = true;
        meta.data = { url, title: change && change.title, navigated: true };
        return reply(provider.mask(withChange(t('res.openedTab', { url }), change)));
      }

      case 'switch_tab': {
        const tabId = Number(args.tab_id);
        const change = await provider.switchTab({ tabId });
        meta.ok = true;
        meta.data = { tabId, title: change && change.title, navigated: true };
        return reply(provider.mask(withChange(t('res.switchedTab', { id: tabId }), change)));
      }

      case 'close_tab': {
        const tabId = args.tab_id == null ? null : Number(args.tab_id);
        const res = await provider.closeTab({ tabId });
        meta.ok = true;
        meta.data = { tabId, navigated: Boolean(res.change && res.change.navigated) };
        const head = t('res.closedTab', {
          which: tabId == null ? t('res.closedWorkTab') : ` ${tabId}`,
          remaining: res.remaining,
        });
        return reply(provider.mask(withChange(head, res.change)));
      }

      case 'list_tabs': {
        const tabs = await provider.listTabs();
        meta.ok = true;
        meta.data = { count: tabs.length };
        return reply(provider.mask(formatTabs(tabs)));
      }

      default:
        return reply(t('res.unknownTool', { name: call.name }));
    }
  } catch (err) {
    // provider 抛出的错误（标签页切换、注入失败、截图失败等）已取词，直接作为工具结果
    return reply((err && err.message) || t('res.toolFailed'));
  }
}
