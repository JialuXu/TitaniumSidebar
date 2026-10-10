// core/tools.js —— 感知与动作工具的定义与分发（平台无关层）
//
// 工具的“执行”由外壳注入的 provider 承担（executeScript/captureVisibleTab/tabs
// 等 chrome.* 接线都在外壳），core 只负责：定义 OpenAI 工具协议、解析参数、
// 调 provider、把结果序列化成发给模型的文本，并统一过 provider.mask 脱敏。
//
// provider 接口：
//   —— 感知 ——
//   searchInPage({ query, maxResults })  → snapshotPage text 模式的搜索返回值
//   readPageText({ offset, length })     → snapshotPage text 模式的读取返回值
//   listElements()                       → { elements, viewport?, stats? }（当前页全部元素，范围与关键词在这里过滤）
//   highlight({ ref })                   → highlightElement 返回值
//   captureScreenshot()                  → { dataUrl, markCount, viewport }
//   waitForPage({ seconds })             → 页面变化（另带 waitedMs：实际等了多久）
//   mask(text)                           → string（未开脱敏时为恒等函数）
//   —— 页内动作（注入 performAction）——
//   act(payload)                         → { result: performAction 返回值, change: 页面变化|null }
//                                           按 ref 的动作在页面未跳转时，change.target 是该 ref 稳定后的 ElementInfo
//   —— 浏览器级动作（chrome.tabs）——
//   navigate({ url }) / goBack() / refresh()        → 页面变化（url 已在这里校验为 http/https）
//   openTab({ url }) / switchTab({ tabId })         → 页面变化
//   closeTab({ tabId })                             → { remaining, change }
//   listTabs()                                      → [{ id, title, url, active, isWork }]
//
// provider 方法失败时 throw Error（message 已按当前语言取词，直接作为工具结果给模型）。
// 「页面变化」形状见 core/format.js 的 formatPageChange。
//
// 工具描述与工具结果都随界面语言切换（文案见 core/i18n.js）：模型看到的说明必须与
// 用户看到的界面同语言，否则英文界面下会得到中文的工具反馈。

import {
  formatElements, formatSearchResults, formatReadResult, formatPageStatus, formatPageChange, formatTabs, BUDGETS,
  TOGGLE_ROLES,
} from './format.js';
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
  'click_element', 'input_text', 'select_option', 'press_key', 'batch_actions',
  'navigate', 'go_back', 'refresh', 'open_tab', 'switch_tab', 'close_tab',
]);

/** batch_actions 单次最多几步：一张表单的字段够用，更长的流程分批做、中途核对 */
export const MAX_BATCH_STEPS = 10;

/**
 * wait_for_page 单次最长等待秒数。后台接口慢到十几秒的都有，再长就该让模型
 * 分几次等并如实告诉用户，而不是一次挂住半分钟。
 */
export const MAX_WAIT_SECONDS = 15;

const SCROLL_DIRECTIONS = ['up', 'down', 'top', 'bottom'];

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

    fn('read_page_text', t('tool.read.d'),
      {
        offset: { type: 'integer', minimum: 0, description: t('tool.read.offset') },
        length: { type: 'integer', minimum: 1, maximum: BUDGETS.readMax, description: t('tool.read.length') },
      },
      ['offset']),

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

    // 等待不改动页面，归感知组：只读模式下用户刚点开的页面同样可能还没加载完
    fn('wait_for_page', t('tool.wait.d'),
      { seconds: { type: 'integer', minimum: 1, maximum: MAX_WAIT_SECONDS, description: t('tool.wait.seconds') } }),
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

      fn('batch_actions', t('tool.batch.d'),
        {
          steps: {
            type: 'array', minItems: 1, maxItems: MAX_BATCH_STEPS, description: t('tool.batch.steps'),
            items: {
              type: 'object',
              properties: {
                action: { type: 'string', enum: Object.keys(PAGE_ACTIONS), description: t('tool.batch.action') },
                ref: { type: 'integer', description: t('tool.batch.ref') },
                text: { type: 'string', description: t('tool.batch.text') },
                option: { type: 'string', description: t('tool.batch.option') },
                key: { type: 'string', enum: ALLOWED_KEYS, description: t('tool.batch.key') },
                direction: { type: 'string', enum: SCROLL_DIRECTIONS, description: t('tool.batch.direction') },
              },
              required: ['action'],
            },
          },
        },
        ['steps']),

      fn('scroll_page', t('tool.scroll.d'),
        {
          direction: { type: 'string', enum: SCROLL_DIRECTIONS, description: t('tool.scroll.direction') },
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

/**
 * list_elements 的范围与关键词过滤。元素名、行锚点或当前值命中都算：
 * 「勾选 Cursor Team 那封」靠的是行文字匹配到无名勾选框，按文本框里写的内容找它靠的是值。
 */
function filterElements(elements, { scope, query }) {
  let list = elements || [];
  if (scope === 'viewport') list = list.filter((e) => e.inViewport);
  if (query) {
    const needle = query.toLowerCase();
    list = list.filter((e) => [e.name, e.context, e.value].some((s) => (s || '').toLowerCase().includes(needle)));
  }
  return list;
}

// 导航类工具只放行 http/https：javascript:、file:、chrome:// 一律不交给 provider
const HTTP_URL = /^https?:\/\//i;

/* ========== 页内动作（单步工具与 batch_actions 共用） ========== */

// 勾选类控件以页面稳定后回读的状态为准：组件库在下一个微任务或下一帧才改 aria-checked，
// 点击当下读到的还是旧值
function toggledTarget(change) {
  const el = change && change.target;
  return el && TOGGLE_ROLES.has(el.role) && !el.isNew ? el : null;
}

const named = (name) => (name ? ` "${name}"` : '');

// 调试通道退回合成事件时补一句（见 drivers/index.js 的 fallback）
const FALLBACK_TEXT = { unavailable: 'res.fallback.unavailable', 'unsafe-point': 'res.fallback.unsafePoint' };
function fallbackNote(r) {
  return r && FALLBACK_TEXT[r.fallback] ? t(FALLBACK_TEXT[r.fallback]) : '';
}

// 按键补偿的实际效果 → 文案片段（见 core/actions.js 的 keyDefault）
function keyEffectText(effect) {
  if (!effect || !effect.moved) return '';
  if (effect.kind === 'delete') return t('res.keyDeleted', { n: effect.removed });
  if (effect.kind === 'scroll') return t('res.keyScrolled', { where: t('res.keyWhere.' + effect.where), px: Math.abs(effect.px) });
  if (typeof effect.from !== 'number') return t('res.keyCaretMoved');
  const caret = effect.from !== effect.to ? t('res.keyCaret', { from: effect.from, to: effect.to }) : '';
  const scrolled = effect.px ? t('res.keyScrolled', { where: t('res.keyWhere.field'), px: Math.abs(effect.px) }) : '';
  return caret + scrolled;
}

// 补偿过、却什么都没变：光标、滚动、内容不动，页面上也没有新元素或状态变化
function keyIdle(r, change) {
  if (!r.effect || r.effect.moved) return false;
  if (!change) return true;
  return !change.navigated && !(change.newElements || []).length && !(change.changedElements || []).length;
}

/**
 * 页内动作：参数 → performAction 载荷、成功文案与活动行数据。
 * 键名即 batch_actions 每一步的 action；tool 是对应的单步工具名。
 *   payload(a)            传给 provider.act 的载荷
 *   ui(a)                 活动行数据的底子（失败时也带上）
 *   text(a, r, change)    成功文案（不含页面变化摘要）
 *   data(a, r, change)    成功时补进活动行数据
 */
const PAGE_ACTIONS = {
  click: {
    tool: 'click_element',
    payload: (a) => ({ action: 'click', ref: Number(a.ref) }),
    ui: (a) => ({ ref: Number(a.ref) }),
    text: (a, r, change) => {
      const el = toggledTarget(change);
      let checked = '';
      if (el) checked = t('res.clickState', { state: el.value || t('fmt.st.unchecked') });
      else if (typeof r.checked === 'boolean') checked = t(r.checked ? 'res.checkedOn' : 'res.checkedOff');
      const head = t('res.clicked', { ref: Number(a.ref), name: named(r.name), checked });
      // 状态与上次交给模型时相同，就在结果里说明
      return el && !el.changes ? `${head}\n${t('res.clickNoEffect')}` : head;
    },
    data: (a, r, change) => {
      const el = toggledTarget(change);
      return { name: r.name, ...(el && !el.changes ? { noEffect: true } : {}) };
    },
  },
  input: {
    tool: 'input_text',
    payload: (a) => ({ action: 'input', ref: Number(a.ref), text: String(a.text == null ? '' : a.text) }),
    ui: (a) => ({ ref: Number(a.ref), text: String(a.text == null ? '' : a.text) }),
    text: (a, r) => t('res.inputDone', { ref: Number(a.ref), name: named(r.name), value: r.value }),
    data: (a, r) => ({ name: r.name }),
  },
  select: {
    tool: 'select_option',
    payload: (a) => ({ action: 'select', ref: Number(a.ref), option: String(a.option == null ? '' : a.option) }),
    ui: (a) => ({ ref: Number(a.ref), option: String(a.option == null ? '' : a.option) }),
    text: (a, r) => t('res.selected', { ref: Number(a.ref), name: named(r.name), value: r.value }),
    data: (a, r) => ({ name: r.name, value: r.value }),
  },
  key: {
    tool: 'press_key',
    payload: (a) => ({ action: 'key', key: String(a.key || ''), ...(a.ref == null ? {} : { ref: Number(a.ref) }) }),
    ui: (a) => ({ key: String(a.key || ''), ref: a.ref == null ? null : Number(a.ref) }),
    text: (a, r, change) => {
      let extra = r.submitted
        ? t('res.keySubmitted')
        : (r.movedTo ? t('res.keyMoved', { name: r.movedTo }) : '');
      if (r.prevented) extra += t('res.keyPrevented');
      extra += keyEffectText(r.effect);
      const target = r.target ? t('res.keyTarget', { name: r.target }) : '';
      const head = t('res.keyDone', { key: r.key, target, extra });
      return keyIdle(r, change) ? `${head}\n${t('res.keyNoChange')}` : head;
    },
    data: (a, r, change) => ({ key: r.key, submitted: r.submitted, ...(keyIdle(r, change) ? { noEffect: true } : {}) }),
  },
  scroll: {
    tool: 'scroll_page',
    payload: (a) => ({
      action: 'scroll',
      direction: SCROLL_DIRECTIONS.includes(a.direction) ? a.direction : 'down',
      pages: Number(a.pages) || 1,
    }),
    ui: (a) => ({
      direction: SCROLL_DIRECTIONS.includes(a.direction) ? a.direction : 'down',
      pages: Number(a.pages) || 1,
    }),
    text: (a, r) => `${t('res.scrolled.' + r.direction)}\n${formatPageStatus(r.viewport, null)}`,
    data: (a, r) => ({ direction: r.direction }),
  },
};

/** 工具名 → 页内动作（单步工具分发用） */
const PAGE_ACTION_BY_TOOL = Object.fromEntries(Object.values(PAGE_ACTIONS).map((spec) => [spec.tool, spec]));

/**
 * batch_actions 某一步之后该不该停：页面跳转、用户切走标签页、编号整体重建、页面内容仍在变动——
 * 这几种情况下后面几步手里的编号或时机都不再可靠。返回停下的原因文案，可以继续时返回空串。
 */
function batchHalt(change) {
  if (!change) return '';
  if (change.navigated || change.restricted) return t('res.batchHaltNavigated');
  if (change.userSwitched) return t('res.batchHaltSwitched');
  if (change.rebuilt) return t('res.batchHaltRebuilt');
  if (change.loading) return t('res.batchHaltLoading');
  return '';
}

/**
 * 把批量执行里逐步的页面变化合成一份：
 * - 跳转了就以最后一步（跳转那一步）为准；
 * - 新增元素取并集，最后一步时已不在页面上的去掉（点开下拉、选完收起，选项就不该再报）；
 * - 状态变化按元素合并，每个字段取最早的 from 与最晚的 to，前后抵消的字段与元素去掉；
 *   先新增、后又变了状态的元素只按新增报，信息取最新一份。
 * @param {Array<object|null>} changes 每一步 provider.act 返回的 change
 * @returns {object|null} formatPageChange 能直接用的页面变化
 */
export function mergePageChanges(changes) {
  const list = (changes || []).filter(Boolean);
  if (!list.length) return null;
  const last = list[list.length - 1];
  if (last.navigated || last.restricted) return last;

  const fresh = new Map();
  const changed = new Map();
  for (const change of list) {
    for (const el of change.newElements || []) {
      fresh.set(el.ref, el);
      changed.delete(el.ref);
    }
    for (const el of change.changedElements || []) {
      if (fresh.has(el.ref)) {
        const { changes: _ignored, ...info } = el;
        fresh.set(el.ref, { ...info, isNew: true });
        continue;
      }
      const prev = changed.get(el.ref);
      const byKey = new Map((prev ? prev.changes : []).map((c) => [c.key, c]));
      for (const c of el.changes) {
        const before = byKey.get(c.key);
        byKey.set(c.key, { key: c.key, from: before ? before.from : c.from, to: c.to });
      }
      changed.set(el.ref, { ...el, changes: [...byKey.values()] });
    }
  }
  const alive = Array.isArray(last.liveRefs) ? new Set(last.liveRefs) : null;
  const newElements = [...fresh.values()].filter((el) => !alive || alive.has(el.ref));
  const changedElements = [...changed.values()]
    .map((el) => ({ ...el, changes: el.changes.filter((c) => c.from !== c.to) }))
    .filter((el) => el.changes.length);
  return { ...last, newElements, changedElements };
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
 * @param {{ readChars?: number, url?: string, textTotal?: number }} [turn]
 *   本回合的读取账本与「模型手里那份页面」的基准：外壳在回合开始时按 sentPage 填好，
 *   读取时对不上就给模型一句告警（位置会随页面变化漂移，不变式 9）。
 * @param {Set<string>} [registered] 本次请求实际注册的工具名。不在其中的调用一律不执行：
 *   开关只决定工具组不组进请求，网关照样可能返回未注册的 click_element / capture_screenshot，
 *   不拦就等于绕过「允许页面操作」与视觉开关。缺省视为什么都没注册，而不是不校验。
 * @returns {Promise<{
 *   toolMessage: { role: 'tool', tool_call_id: string, content: string },
 *   followUpMessage?: object,   // 截图工具专用：紧随 tool 消息的多模态 user 消息
 *   meta: { name: string, args: object|null, ok: boolean, data: object },
 * }>}
 */
export async function dispatchToolCall(call, provider, turn = {}, registered = new Set()) {
  const meta = { name: call.name, args: null, ok: false, data: {} };
  const reply = (content, followUpMessage) => ({
    toolMessage: { role: 'tool', tool_call_id: call.id, content },
    ...(followUpMessage ? { followUpMessage } : {}),
    meta,
  });

  if (!registered.has(call.name)) {
    meta.data = { reason: 'not-registered' };
    return reply(t('res.notRegistered', { name: call.name }));
  }

  // 参数解析容错：坏 JSON 不中断循环，把错误还给模型让它自我纠正
  let args = {};
  try {
    args = call.arguments ? JSON.parse(call.arguments) : {};
  } catch {
    return reply(t('res.badJson'));
  }
  meta.args = args;

  // 跳转之后模型手里的基准就换成新页了（跳转摘要本身带着新页的正文字数），
  // 不同步的话后面每次读取都会误报「位置可能已过期」。
  const withChangeSynced = (text, change) => {
    if (change && change.navigated) {
      turn.url = change.url || '';
      turn.textTotal = change.stats ? change.stats.textTotal : 0;
    }
    return withChange(text, change);
  };

  // 页内单步动作的公共壳：失败映射成可读文案，成功拼「结果描述 + 页面变化摘要」
  const doAct = async (spec) => {
    const { result, change } = await provider.act(spec.payload(args));
    meta.data = spec.ui(args);
    if (!result || !result.ok) {
      meta.data.reason = result && result.reason;
      return reply(provider.mask(describeFailure(result, args)));
    }
    meta.ok = true;
    meta.data.navigated = Boolean(change && change.navigated);
    Object.assign(meta.data, spec.data(args, result, change));
    return reply(provider.mask(withChangeSynced(spec.text(args, result, change) + fallbackNote(result), change)));
  };

  // 批量动作：逐步执行，失败或遇到 batchHalt 就停；每步一行结果，末尾一份合并后的页面变化
  const doBatch = async () => {
    const steps = Array.isArray(args.steps) ? args.steps : [];
    const total = steps.length;
    meta.data = { total, done: 0 };
    if (!total) return reply(t('res.batchEmpty'));
    if (total > MAX_BATCH_STEPS) return reply(t('res.batchTooMany', { max: MAX_BATCH_STEPS }));

    const lines = [];
    const changes = [];
    const step = (n, text) => lines.push(t('res.batchStep', { n, text: text.replace(/\n/g, '\n   ') }));
    let noEffect = 0;
    let tail = '';
    for (let i = 0; i < total; i++) {
      const a = steps[i] && typeof steps[i] === 'object' ? steps[i] : {};
      const spec = PAGE_ACTIONS[a.action];
      const failAt = (text, reason) => {
        step(i + 1, text);
        meta.data.reason = reason;
        tail = t('res.batchFailed', { n: i + 1, rest: total - i - 1 });
      };
      if (!spec) { failAt(t('res.batchBadStep', { action: String(a.action || '') }), 'bad-step'); break; }
      let outcome;
      try {
        outcome = await provider.act(spec.payload(a));
      } catch (err) {
        failAt((err && err.message) || t('res.toolFailed'), 'error');
        break;
      }
      const { result, change } = outcome || {};
      if (!result || !result.ok) { failAt(describeFailure(result, a), result && result.reason); break; }
      meta.data.done = i + 1;
      step(i + 1, spec.text(a, result, change) + fallbackNote(result));
      if (spec.data(a, result, change).noEffect) noEffect++;
      if (change) changes.push(change);
      const halt = batchHalt(change);
      if (halt && i < total - 1) { tail = t('res.batchStopped', { n: i + 1, reason: halt, rest: total - i - 1 }); break; }
    }

    const merged = mergePageChanges(changes);
    meta.ok = !meta.data.reason;
    meta.data.navigated = Boolean(merged && merged.navigated);
    if (noEffect) meta.data.noEffect = noEffect;
    const text = [t('res.batchHead', { done: meta.data.done, total }), ...lines, tail].filter(Boolean).join('\n');
    return reply(provider.mask(merged ? withChangeSynced(text, merged) : text));
  };

  try {
    switch (call.name) {
      /* ================= 感知组 ================= */
      case 'find_in_page': {
        const query = String(args.query || '').trim();
        if (!query) return reply(t('res.missingQuery'));
        const res = await provider.searchInPage({ query, maxResults: args.max_results });
        meta.ok = Boolean(res && res.ok);
        const outsideTotal = (res && res.outside && res.outside.total) || 0;
        meta.data = { query, total: ((res && res.total) || 0) + outsideTotal };
        return reply(provider.mask(formatSearchResults(res, query)));
      }

      case 'read_page_text': {
        // 保险丝：模型一口气并行读十段会撑爆上下文窗口，而工具结果会留在历史里，
        // 之后每一条请求都超窗 400——整个会话就此报废。宁可这一轮少读一点。
        const used = turn.readChars || 0;
        const left = BUDGETS.readPerTurn - used;
        if (left < 1000) {
          meta.data = { budget: true };
          return reply(t('res.readBudget'));
        }
        const want = Math.min(Number(args.length) || BUDGETS.read, BUDGETS.readMax, left);
        const offset = Math.max(0, Number(args.offset) || 0);
        const res = await provider.readPageText({ offset, length: want });
        if (!res || !res.ok) {
          meta.data = { offset, reason: res && res.reason };
          return reply(describeFailure(res, args));
        }
        // 位置是「模型上次看到的那份正文」的坐标；页面换了或长度变了就可能已经漂了
        const drifted = (turn.url && res.url && turn.url !== res.url) ||
          (turn.textTotal && res.total && turn.textTotal !== res.total);
        turn.readChars = used + res.text.length;
        turn.url = res.url;
        turn.textTotal = res.total;
        meta.ok = true;
        meta.data = { start: res.start, end: res.end, total: res.total, section: res.section };
        const text = provider.mask(formatReadResult(res, {
          warning: drifted ? t('res.readStale') : '',
        }));
        // `_read` 标记这条消息是可回收的正文（换页作废 / 跨回合收口，见 core/conversation.js）
        return { toolMessage: { role: 'tool', tool_call_id: call.id, content: text, _read: { start: res.start, end: res.end, url: res.url } }, meta };
      }

      case 'list_elements': {
        const scope = args.scope === 'page' ? 'page' : 'viewport';
        const query = args.query ? String(args.query).trim() : '';
        const res = await provider.listElements();
        const elements = filterElements(res.elements, { scope, query });
        meta.ok = true;
        meta.data = { scope, count: elements.length, total: elements.length };
        const header = t('res.listHead', {
          scope: t(scope === 'viewport' ? 'res.scopeViewport' : 'res.scopePage'),
          filter: query ? t('res.listFilter', { query }) : '',
          total: elements.length,
        });
        const status = formatPageStatus(res.viewport, res.stats);
        const legend = elements.some((e) => e.isNew) ? t('res.newLegend') : '';
        const head = [status, legend, header].filter(Boolean).join('\n');
        // query 过滤 = 模型在钻取具体某几个元素，此时逐项列出（不折叠同构组）
        return reply(provider.mask(head + '\n' + formatElements(elements, { total: elements.length, collapse: !query })));
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

      case 'wait_for_page': {
        const seconds = Math.min(Math.max(Math.round(Number(args.seconds)) || 3, 1), MAX_WAIT_SECONDS);
        const change = await provider.waitForPage({ seconds });
        const waited = Math.max(1, Math.round((change.waitedMs || 0) / 1000));
        meta.ok = true;
        meta.data = { seconds: waited, settled: !change.loading, navigated: Boolean(change.navigated) };
        // 稳定了就明说；没稳定的话 formatPageChange 末尾会带上「内容仍在变动」的提醒
        const head = t('res.waited', { s: waited, settled: change.loading ? '' : t('res.waitedSettled') });
        return reply(provider.mask(withChangeSynced(head, change)));
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
      case 'click_element':
      case 'input_text':
      case 'select_option':
      case 'press_key':
      case 'scroll_page':
        return await doAct(PAGE_ACTION_BY_TOOL[call.name]);

      case 'batch_actions':
        return await doBatch();

      /* ================= 动作组：浏览器级 ================= */
      case 'navigate': {
        const url = String(args.url || '').trim();
        if (!HTTP_URL.test(url)) return reply(t('sys.badUrl'));
        const change = await provider.navigate({ url });
        meta.ok = true;
        meta.data = { url, title: change && change.title, navigated: true };
        return reply(provider.mask(withChangeSynced(t('res.navigated', { url }), change)));
      }

      case 'go_back': {
        const change = await provider.goBack();
        meta.ok = true;
        meta.data = { title: change && change.title, navigated: true };
        return reply(provider.mask(withChangeSynced(t('res.wentBack'), change)));
      }

      case 'refresh': {
        const change = await provider.refresh();
        meta.ok = true;
        meta.data = { title: change && change.title, navigated: true };
        return reply(provider.mask(withChangeSynced(t('res.refreshed'), change)));
      }

      case 'open_tab': {
        const url = String(args.url || '').trim();
        if (!HTTP_URL.test(url)) return reply(t('sys.badUrl'));
        const change = await provider.openTab({ url });
        meta.ok = true;
        meta.data = { url, title: change && change.title, navigated: true };
        return reply(provider.mask(withChangeSynced(t('res.openedTab', { url }), change)));
      }

      case 'switch_tab': {
        const tabId = Number(args.tab_id);
        const change = await provider.switchTab({ tabId });
        meta.ok = true;
        meta.data = { tabId, title: change && change.title, navigated: true };
        return reply(provider.mask(withChangeSynced(t('res.switchedTab', { id: tabId }), change)));
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
        return reply(provider.mask(withChangeSynced(head, res.change)));
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
