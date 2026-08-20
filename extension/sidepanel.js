// sidepanel.js —— 扩展外壳：UI 渲染与状态、chrome.* API 接线、把 core 模块串起来。
// 业务逻辑（提取/脱敏/组装/调用/渲染/校验）全部在 core/，本文件不实现任何业务规则。

import { snapshotPage } from './core/snapshot.js';
import { searchPage } from './core/search.js';
import { highlightElement } from './core/highlight.js';
import { performAction } from './core/actions.js';
import {
  buildToolDefs, dispatchToolCall, MAX_TOOL_ROUNDS, MAX_ACTION_ROUNDS, WRITE_TOOL_NAMES,
} from './core/tools.js';
import { annotateScreenshot } from './core/annotate.js';
import { formatOutline, formatTextDiff } from './core/format.js';
import { maskSensitive } from './core/masker.js';
import { buildSystemPrompt, buildUserContent, buildPageUpdate, buildCompactPrompt } from './core/prompt.js';
import { parseCompactCommand, buildCompactState, compactRequestTail } from './core/compact.js';
import { streamChat, testConnection, LlmError } from './core/llm-client.js';
import { renderMarkdown } from './core/markdown.js';
import { verifyQuote } from './core/citation.js';
import { listSkills, matchSkillsByUrl, hostOfUrl } from './core/skills.js';
import {
  createHistoryStore, newSessionId, deriveSessionTitle, countTurns, HISTORY_RECORD_VERSION,
} from './core/history.js';
import {
  t, setLocale, detectLocale, injectedStrings, LOCALES, LOCALE_LABELS, HTML_LANG,
} from './core/i18n.js';

/* ========== 存储适配器（外壳注入；SDK 外壳将来换 localStorage/后端下发实现） ========== */
const storage = {
  async get(key) {
    const obj = await chrome.storage.local.get(key);
    return obj[key];
  },
  async set(key, value) {
    await chrome.storage.local.set({ [key]: value });
  },
  // 历史会话的删除/淘汰需要真正移除键（set undefined 删不掉），接口在 get/set 之外多一个 remove
  async remove(key) {
    await chrome.storage.local.remove(key);
  },
};

// 历史会话存储：索引与记录分键存放，超过 50 条自动淘汰最旧（见 core/history.js）
const historyStore = createHistoryStore(storage, { maxSessions: 50 });

/* ========== 全局状态 ========== */
const DEFAULT_CONFIG = {
  baseUrl: '', model: '', apiKey: '',
  maskEnabled: true,
  visionEnabled: false,
  actionsEnabled: false, // 允许页面操作（点击/输入/跳转），默认关闭
  locale: '',            // 界面与模型文案的语言；空串=跟随浏览器（首次启动时判定）
};

// 模型「已经看到的页面」的初值：text 为空表示还没给模型看过任何页面内容
function initialSentPage() {
  return { text: '', outline: '', url: '', title: '', diffChars: 0 };
}

function initialPage() {
  return {
    status: 'none',          // none 未读取 | ok 已读取 | unreadable 无法读取
    title: '',
    url: '',
    maskedText: '',          // 脱敏后的页面文本：注入 prompt 与引用校验共用同一份
    outlineText: '',         // 脱敏后的结构骨架文本（注入 prompt + 详情面板展示）
    elementCount: 0,         // 快照时的可交互元素数（状态条展示）
    session: '',             // ref 映射的会话标识，页面侧 window.__titanium 持有同名值
    // 工作标签页：快照来源，也是所有感知与动作的作用对象。
    // open_tab/switch_tab 会把它转移到新标签页（并同步激活），
    // 因此「浏览器激活页 === 工作页」这一不变式始终成立，守卫逻辑无需改动。
    tabId: null,
    hits: null,              // 脱敏命中计数 { idCard, bankCard, phone }，未开脱敏为 null
  };
}

const state = {
  config: { ...DEFAULT_CONFIG },
  // 消息历史：content 是真实请求内容（首条 user 含 <页面内容> 块），
  // displayContent 只存用户敲入的原话用于渲染（不把 12000 字页面文本刷进 UI）。
  // 工具调用轮次会追加 assistant(tool_calls)/tool/截图跟随消息，`_` 前缀字段发请求前剔除。
  messages: [],
  page: initialPage(),           // 当前页面的最新快照（面板展示、引用校验、ref 映射的依据）
  // 模型「已经看到的页面」：每条消息发送前拿它与最新快照比对，决定是不带、带差异还是带全文。
  // 与 state.page 分开是必需的——AI 操作导致跳转时 state.page 已换成新页，
  // 而模型手上还是旧页，只有这一份记录能判断出「该给模型新内容了」。
  sentPage: initialSentPage(),
  // 压缩上下文（/compact）：{ summary, boundary } 或 null。
  // summary 是包好标签的整段摘要（语言在压缩那一刻定死），boundary 是压缩点在 messages 中的下标；
  // 之后的请求只带「摘要 + slice(boundary)」，可见消息数组不删不改。会话属性，随会话保存/清空。
  compact: null,
  // phase: idle | streaming | compacting；plusMenuView: root 根菜单 | skills 技能二级列表（菜单关闭时复位）
  ui: {
    phase: 'idle', autoScroll: true, ctxExpanded: false,
    plusMenuOpen: false, plusMenuView: 'root',
    historyOpen: false, // 历史会话浮层是否展开（与页面胶囊浮层互斥）
  },
  abortController: null,
  toolsBroken: false, // 接口不支持 tools（收到过 400/422），本会话降级纯文本；保存配置时重置
  lastCitation: '', // 点击引用徽标暂存的原文（生产版可扩展为定位高亮）
  skillId: null, // 会话级激活技能 id：不入 config、不持久化，「新对话」清空
  // 历史会话身份：sessionId 为 null 表示当前会话还没落过库（首次保存时生成）。
  // 每个回合收尾自动保存一次；「新对话」把身份清空，下一段会话另起一条记录。
  sessionId: null,
  sessionCreatedAt: 0,
  // URL 建议：items 为当前命中的 [{ id, host }]；dismissed 记「host|skillId」，本会话不再建议
  suggest: { items: [], dismissed: new Set() },
};

/* ========== DOM 引用 ========== */
const els = {};
[
  'btn-new-chat', 'btn-settings', 'btn-context', 'ctx-chip-text', 'ctx-dot',
  'ctx-detail', 'ctx-detail-title', 'ctx-detail-url', 'ctx-detail-stats',
  'ctx-detail-outline', 'ctx-detail-text',
  'chat', 'welcome', 'config-hint', 'btn-goto-settings', 'input', 'btn-send',
  'btn-plus', 'plus-menu',
  'skill-suggest', 'skill-chip', 'skill-chip-name', 'skill-chip-remove',
  'btn-history', 'history-pop', 'history-list', 'btn-clear-history',
  'settings-mask', 'settings', 'btn-close-settings', 'cfg-locale', 'cfg-baseurl', 'cfg-model',
  'cfg-apikey', 'cfg-mask', 'cfg-vision', 'cfg-actions', 'btn-test', 'btn-save', 'test-result',
].forEach((id) => {
  els[id.replace(/-([a-z])/g, (_, c) => c.toUpperCase())] = document.getElementById(id);
});

/* ========== 语言（界面文案 + 发给模型的文案共用同一个语言） ========== */

// 静态文案：HTML 里用 data-i18n* 标注，这里按当前语言统一写入。
// textContent 覆写要求元素内只有文字，因此图标按钮/输入框旁的文字都单独包了 span。
function applyStaticI18n(root = document) {
  root.querySelectorAll('[data-i18n]').forEach((el) => {
    el.textContent = t(el.dataset.i18n);
  });
  root.querySelectorAll('[data-i18n-title]').forEach((el) => {
    el.title = t(el.dataset.i18nTitle);
  });
  root.querySelectorAll('[data-i18n-placeholder]').forEach((el) => {
    el.placeholder = t(el.dataset.i18nPlaceholder);
  });
  root.querySelectorAll('[data-i18n-aria]').forEach((el) => {
    el.setAttribute('aria-label', t(el.dataset.i18nAria));
  });
}

// 语言下拉的选项：各语言用自己的写法（简体中文 / English），不随当前语言变化
function renderLocaleOptions() {
  els.cfgLocale.innerHTML = '';
  for (const loc of LOCALES) {
    const opt = document.createElement('option');
    opt.value = loc;
    opt.textContent = LOCALE_LABELS[loc];
    els.cfgLocale.appendChild(opt);
  }
}

// 切换语言：静态文案 + 所有动态渲染的界面一次性刷新。
// 已经渲染在消息流里的历史内容保持原语言不变（那是当时的产物，改写反而失真）。
function applyLocale(loc) {
  const resolved = setLocale(loc);
  document.documentElement.lang = HTML_LANG[resolved];
  applyStaticI18n();
  els.cfgLocale.value = resolved;
  updateContextChip();
  updateComposer();
  renderPlusMenu();
  renderSkillChip();
  renderSkillSuggest();
  // 历史浮层开着才重渲（列表要读存储，没开就不白读一次）；消息流里的历史内容保持原语言
  if (state.ui.historyOpen) renderHistoryList();
}

/* ========== 配置 ========== */
function isConfigured() {
  return Boolean(state.config.baseUrl && state.config.model);
}

function updateConfigHint() {
  els.configHint.hidden = isConfigured();
}

async function loadConfig() {
  const saved = await storage.get('config');
  if (saved) state.config = { ...DEFAULT_CONFIG, ...saved };
  // 未选过语言时按浏览器语言判定一次，并落盘（此后不再随浏览器变化）
  if (!LOCALES.includes(state.config.locale)) {
    state.config.locale = detectLocale(navigator.languages || navigator.language);
    await storage.set('config', state.config);
  }
}

function readConfigForm() {
  return {
    baseUrl: els.cfgBaseurl.value.trim(),
    model: els.cfgModel.value.trim(),
    apiKey: els.cfgApikey.value.trim(),
    maskEnabled: els.cfgMask.checked,
    visionEnabled: els.cfgVision.checked,
    actionsEnabled: els.cfgActions.checked,
    locale: els.cfgLocale.value, // 语言在选中时即时生效并落盘，这里只是保持整份配置完整
  };
}

function fillConfigForm() {
  els.cfgLocale.value = state.config.locale;
  els.cfgBaseurl.value = state.config.baseUrl;
  els.cfgModel.value = state.config.model;
  els.cfgApikey.value = state.config.apiKey;
  els.cfgMask.checked = state.config.maskEnabled;
  els.cfgVision.checked = state.config.visionEnabled;
  els.cfgActions.checked = state.config.actionsEnabled;
}

/* ========== 错误文案映射（外壳职责，core 只抛结构化错误） ========== */
function describeError(err) {
  if (err instanceof LlmError) {
    switch (err.kind) {
      case 'badconfig':
        return t('err.badconfig');
      case 'network':
        return t('err.network');
      case 'stream':
        return t('err.stream');
      case 'http': {
        if (err.status === 401) return t('err.http401');
        if (err.status === 403) return t('err.http403');
        if (err.status === 404) return t('err.http404');
        if (err.status === 429) return t('err.http429');
        if (err.status >= 500) return t('err.http5xx', { status: err.status });
        const detail = (err.detail || '').slice(0, 200);
        return t('err.httpOther', { status: err.status, detail: detail ? t('err.detailPrefix') + detail : '' });
      }
    }
  }
  return t('err.unknown', { message: (err && err.message) || String(err) });
}

/* ========== 顶部页面胶囊（读取状态的唯一出口） ========== */
// 胶囊很窄，标题上限相应收紧；英文同宽度下字数更多
function truncateTitle(title, max = document.documentElement.lang === 'en' ? 26 : 16) {
  if (!title) return t('ui.untitled');
  return title.length > max ? title.slice(0, max) + '…' : title;
}

// 展开/折叠「已读取内容」浮层（仅 status 为 ok 时可展开）
function setCtxExpanded(expanded) {
  state.ui.ctxExpanded = expanded && state.page.status === 'ok';
  els.ctxDetail.hidden = !state.ui.ctxExpanded;
  els.btnContext.classList.toggle('open', state.ui.ctxExpanded);
  els.btnContext.setAttribute('aria-expanded', String(state.ui.ctxExpanded));
}

// 读取状态全部收在这颗胶囊里：没读过整颗隐藏，读过只留标题，其余细节点开才看。
// 没有「重新读取」按钮——重新读取由发送前的自动比对负责（见 syncPageForSend）。
function updateContextChip(transient) {
  const { page } = state;
  const reading = transient === 'reading';
  els.btnContext.hidden = !reading && page.status !== 'ok' && page.status !== 'unreadable';
  els.btnContext.classList.toggle('reading', reading);
  els.btnContext.classList.toggle('muted', !reading && page.status !== 'ok');
  els.btnContext.disabled = page.status !== 'ok' || reading;
  els.ctxDot.hidden = true;

  if (reading) {
    els.ctxChipText.textContent = t('ui.ctxReading');
    els.btnContext.title = '';
    setCtxExpanded(false);
    return;
  }

  if (page.status !== 'ok') {
    els.ctxChipText.textContent = t('ui.ctxUnreadable');
    els.btnContext.title = '';
    setCtxExpanded(false);
    return;
  }

  els.ctxChipText.textContent = truncateTitle(page.title);
  els.btnContext.title = t('ui.ctxChipTitle', { title: page.title || '' });
  // 浮层内容与当前读取结果保持同步（textContent 赋值，无注入风险）
  els.ctxDetailTitle.textContent = page.title || t('ui.untitled');
  els.ctxDetailUrl.textContent = t('ui.ctxReadFrom', { url: page.url });
  els.ctxDetailStats.textContent = t('ui.ctxMeta', {
    chars: page.maskedText.length, n: page.elementCount,
  });
  els.ctxDetailOutline.textContent = page.outlineText;
  els.ctxDetailOutline.hidden = !page.outlineText;
  els.ctxDetailText.textContent = page.maskedText;
  setCtxExpanded(state.ui.ctxExpanded); // 内容更新后维持原展开状态

  const hits = page.hits;
  const total = hits ? hits.idCard + hits.bankCard + hits.phone : 0;
  if (total > 0) {
    els.ctxDot.title = t('ui.maskBadgeTitle', hits);
    els.ctxDot.hidden = false;
    els.ctxDetailStats.textContent += ` · ${t('ui.maskBadge', { n: total })}`;
  }
}

/* ========== 页面提取（chrome.* 接线） ========== */
// 无法注入脚本的页面：浏览器内部页、扩展页、商店页等
function isRestrictedUrl(url) {
  if (!url) return true;
  return (
    /^(chrome|edge|about|devtools|view-source|chrome-extension|edge-extension|moz-extension):/i.test(url) ||
    url.startsWith('https://chromewebstore.google.com') ||
    url.startsWith('https://microsoftedge.microsoft.com/addons')
  );
}

// 取当前激活标签页；受限页返回 null
async function getActiveTab() {
  let tab;
  try {
    [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  } catch {
    return null;
  }
  if (!tab || !tab.id || isRestrictedUrl(tab.url)) return null;
  return tab;
}

// 对目标标签页注入 core 导出的自包含函数（snapshotPage/searchPage/highlightElement），
// args 需为 JSON 可序列化数据。失败统一返回 null，由调用方归一处理。
async function injectFunc(tabId, func, args) {
  try {
    const results = await chrome.scripting.executeScript({
      target: { tabId },
      func,
      args: args ? [args] : [],
    });
    return (results && results[0] && results[0].result) || null;
  } catch {
    return null;
  }
}

// 完整快照当前激活标签页（文本 + 结构骨架 + 元素映射重建）。
// 失败（受限页/注入被拒/无可读内容）统一返回 null，由调用方归一为「页面不可读」。
async function snapshotCurrentTab() {
  const tab = await getActiveTab();
  if (!tab) return null;
  // 每条消息发送前都会走这里重读一次。仍是同一标签页的同一网址时按指纹继承旧编号，
  // 模型在会话中已经见过的 ref 才不会因为一次例行重读而集体作废；换了页面则干净重编。
  const inheritRefs = tab.id === state.page.tabId && tab.url === state.page.url;
  const result = await injectFunc(tab.id, snapshotPage, {
    mode: 'full', maxTextLen: 12000, maxElements: 1500, inheritRefs, i18n: injectedStrings(),
  });
  if (!result || !result.ok || !result.text) return null;
  return { ...result, tabId: tab.id };
}

// 把一次 full 快照写入 state.page（脱敏 + 命中合并）。
// 发送前的例行重读与动作导致跳转后的重建共用这一份，避免两处规则漂移。
function applySnapshot(snap, tabId) {
  // 文本与结构骨架都走文本通道，发给模型前必须一并脱敏；命中数合并计入徽标
  const outlineRaw = formatOutline(snap.outline);
  const maskOn = state.config.maskEnabled;
  const textRes = maskOn ? maskSensitive(snap.text) : { text: snap.text, hits: null };
  const outlineRes = maskOn ? maskSensitive(outlineRaw) : { text: outlineRaw, hits: null };
  state.page = {
    status: 'ok',
    title: snap.title,
    url: snap.url,
    maskedText: textRes.text,
    outlineText: outlineRes.text,
    elementCount: snap.stats.totalElements,
    session: snap.session,
    tabId,
    hits: textRes.hits
      ? {
          idCard: textRes.hits.idCard + outlineRes.hits.idCard,
          bankCard: textRes.hits.bankCard + outlineRes.hits.bankCard,
          phone: textRes.hits.phone + outlineRes.hits.phone,
        }
      : null,
  };
}

/* ========== 感知工具 provider（chrome.* 接线，执行由 core/tools.js 调度） ========== */

// 工具执行前置校验：当前激活标签页必须仍是快照来源页（截图截的就是激活页，必须守卫）
async function requireSnapshotTab() {
  const tab = await getActiveTab();
  if (!tab) throw new Error(t('sys.restrictedPage'));
  if (state.page.tabId !== null && tab.id !== state.page.tabId) {
    throw new Error(t('sys.tabSwitched'));
  }
  return tab;
}

// 刷新元素快照：老元素保号、新元素续编；session 过期（页面已导航）时自动全量重建
async function refreshedElements(tab) {
  let res = await injectFunc(tab.id, snapshotPage, {
    mode: 'elements', session: state.page.session, maxElements: 1500, i18n: injectedStrings(),
  });
  if (res && res.ok === false && res.reason === 'stale') {
    // maxTextLen 给最小值：全量重建只为拿元素映射，不需要文本通道的开销。
    // inheritRefs 让指纹相同的元素继承旧编号——SPA 重渲染后模型手里的 ref 仍然有效。
    const full = await injectFunc(tab.id, snapshotPage, {
      mode: 'full', maxTextLen: 1, maxElements: 1500, inheritRefs: true, i18n: injectedStrings(),
    });
    if (full && full.ok) {
      state.page.session = full.session;
      res = { ok: true, elements: full.elements, viewport: full.viewport, stats: full.stats };
    }
  }
  if (!res || !res.ok) throw new Error(t('sys.elementsUnreadable'));
  return res;
}

/* ========== 动作后的页面变化同步 ========== */

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// 轮询到标签页加载完成（导航是异步的，动作返回时新页面往往还没开始加载）
async function waitForTabComplete(tabId, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    let tab = null;
    try { tab = await chrome.tabs.get(tabId); } catch { return null; }
    if (tab.status === 'complete') return tab;
    await sleep(150);
  }
  try { return await chrome.tabs.get(tabId); } catch { return null; }
}

// 页面已跳转：全量重建快照并整体更新 state.page。
// 新页全文刻意不在本回合塞给模型（回合内 token 会爆，tool 消息对之间也插不进 user 消息），
// 而是留给下一条用户消息——那时 state.sentPage 与新页网址不符，自动携带新页全文。
async function rebuildPageAfterNavigation(tab) {
  if (!tab || !tab.id || isRestrictedUrl(tab.url)) {
    state.page = { ...state.page, status: 'unreadable', tabId: tab && tab.id ? tab.id : state.page.tabId };
    updateContextChip();
    return { navigated: true, restricted: true };
  }
  const snap = await injectFunc(tab.id, snapshotPage, {
    mode: 'full', maxTextLen: 12000, maxElements: 1500, i18n: injectedStrings(),
  });
  if (!snap || !snap.ok) {
    state.page = { ...state.page, status: 'unreadable', tabId: tab.id };
    updateContextChip();
    return { navigated: true, restricted: true };
  }
  applySnapshot(snap, tab.id);
  updateContextChip();
  return {
    navigated: true, title: snap.title, url: snap.url,
    viewport: snap.viewport, stats: snap.stats,
  };
}

// 动作执行后感知页面变化，产出给模型的变化摘要。
// mayNavigate：点击/回车这类可能触发跳转的动作要等加载完成，输入/选择则无需等待。
async function syncAfterAction({ mayNavigate }) {
  await sleep(300); // 静默期：给 SPA 重渲染或导航启动留出时间

  // target=_blank 的链接与 window.open 会把激活页换成新标签页，收养它为新的工作页
  let active = null;
  try { [active] = await chrome.tabs.query({ active: true, currentWindow: true }); } catch { /* 忽略 */ }
  const adopted = Boolean(active && active.id && active.id !== state.page.tabId);
  if (adopted) state.page.tabId = active.id;

  const tab = mayNavigate || adopted
    ? await waitForTabComplete(state.page.tabId, 8000)
    : await chrome.tabs.get(state.page.tabId).catch(() => null);
  if (!tab) return { navigated: true, restricted: true };

  if (adopted || (tab.url && tab.url !== state.page.url)) {
    return await rebuildPageAfterNavigation(tab);
  }

  // 未跳转：增量刷新，把新出现的元素（带 * 标记）报告给模型
  try {
    const snap = await refreshedElements(tab);
    return {
      navigated: false,
      newElements: snap.elements.filter((e) => e.isNew),
      viewport: snap.viewport,
      stats: snap.stats,
    };
  } catch {
    return { navigated: false, newElements: [] };
  }
}

// 导航类动作的统一收尾：等加载完成 → 全量重建 → 返回变化摘要
async function afterNavigation(tabId) {
  state.page.tabId = tabId;
  await sleep(400); // 让导航真正开始，否则会读到旧页面的 complete 状态
  const tab = await waitForTabComplete(tabId, 10000);
  return await rebuildPageAfterNavigation(tab);
}

function requireHttpUrl(url) {
  const target = String(url || '').trim();
  if (!/^https?:\/\//i.test(target)) {
    throw new Error(t('sys.badUrl'));
  }
  return target;
}

let lastCaptureAt = 0; // 上次 captureVisibleTab 的时间戳（配额限流用）

const provider = {
  // 所有走文本通道的工具结果发给模型前统一脱敏（截图无法脱敏，见设置项说明）
  mask: (t) => (state.config.maskEnabled ? maskSensitive(t).text : t),

  async searchInPage({ query, maxResults }) {
    const tab = await requireSnapshotTab();
    const res = await injectFunc(tab.id, searchPage, { query, maxResults });
    if (!res) throw new Error(t('sys.searchFailed'));
    return res;
  },

  async listElements({ scope, query }) {
    const tab = await requireSnapshotTab();
    const snap = await refreshedElements(tab);
    let elements = snap.elements;
    if (scope === 'viewport') elements = elements.filter((e) => e.inViewport);
    if (query) {
      // 元素名或行锚点命中都算——「勾选 Cursor Team 那封」靠的是行文字匹配到无名勾选框
      const q = query.toLowerCase();
      elements = elements.filter((e) =>
        (e.name || '').toLowerCase().includes(q) || (e.context || '').toLowerCase().includes(q));
    }
    return { elements, total: elements.length, viewport: snap.viewport, stats: snap.stats };
  },

  async highlight({ ref }) {
    const tab = await requireSnapshotTab();
    const res = await injectFunc(tab.id, highlightElement, {
      ref, session: state.page.session, durationMs: 3000,
    });
    if (!res) throw new Error(t('sys.highlightFailed'));
    return res;
  },

  async captureScreenshot() {
    const tab = await requireSnapshotTab();
    // bbox 必须在截图前一刻重测，否则页面滚动/布局变化会让编号框画偏
    const snap = await refreshedElements(tab);
    // captureVisibleTab 配额约 2 次/秒，间隔不足时补足等待
    const wait = 600 - (Date.now() - lastCaptureAt);
    if (wait > 0) await sleep(wait);
    let raw;
    try {
      raw = await chrome.tabs.captureVisibleTab(tab.windowId, { format: 'png' });
    } catch (err) {
      throw new Error(t('sys.shotFailed', { message: (err && err.message) || t('sys.shotDenied') }));
    }
    lastCaptureAt = Date.now();
    const marks = snap.elements
      .filter((e) => e.inViewport)
      .map(({ ref, bbox }) => ({ ref, bbox }));
    const { dataUrl, markCount } = await annotateScreenshot(raw, marks, snap.viewport);
    return { dataUrl, markCount, viewport: snap.viewport };
  },

  /* ---------- 页内动作（注入 core/actions.js 的 performAction） ---------- */

  // 纯读取的动作不需要同步页面变化；点击与按键可能触发跳转，需等加载完成
  async act(payload) {
    const READ_ONLY = { extract_table: 1, get_html: 1 };
    const MAY_NAVIGATE = { click: 1, key: 1 };
    const tab = await requireSnapshotTab();
    const result = await injectFunc(tab.id, performAction, {
      ...payload, session: state.page.session, i18n: injectedStrings(),
    });
    if (!result) throw new Error(t('sys.actFailed'));
    if (READ_ONLY[payload.action] || !result.ok) return { result, change: null };
    const change = await syncAfterAction({ mayNavigate: Boolean(MAY_NAVIGATE[payload.action]) });
    return { result, change };
  },

  /* ---------- 浏览器级动作（chrome.tabs） ---------- */

  async navigate({ url }) {
    const tab = await requireSnapshotTab();
    const target = requireHttpUrl(url);
    await chrome.tabs.update(tab.id, { url: target });
    return await afterNavigation(tab.id);
  },

  async goBack() {
    const tab = await requireSnapshotTab();
    try {
      await chrome.tabs.goBack(tab.id);
    } catch {
      throw new Error(t('sys.noHistory'));
    }
    return await afterNavigation(tab.id);
  },

  async refresh() {
    const tab = await requireSnapshotTab();
    await chrome.tabs.reload(tab.id);
    return await afterNavigation(tab.id);
  },

  // 新开与切换标签页本身就是在转移工作页，不走 requireSnapshotTab 守卫；
  // 它们把目标页设为激活页并更新 state.page.tabId，维持「激活页 === 工作页」不变式
  async openTab({ url }) {
    const target = requireHttpUrl(url);
    const tab = await chrome.tabs.create({ url: target, active: true });
    return await afterNavigation(tab.id);
  },

  async switchTab({ tabId }) {
    if (!Number.isInteger(tabId)) throw new Error(t('sys.badTabId'));
    let tab;
    try {
      tab = await chrome.tabs.update(tabId, { active: true });
    } catch {
      throw new Error(t('sys.tabGone', { id: tabId }));
    }
    return await afterNavigation(tab.id);
  },

  async closeTab({ tabId }) {
    const target = tabId == null ? state.page.tabId : tabId;
    if (target == null) throw new Error(t('sys.noWorkTab'));
    const closingWorkTab = target === state.page.tabId;
    try {
      await chrome.tabs.remove(target);
    } catch {
      throw new Error(t('sys.tabClosed', { id: target }));
    }
    const tabs = await chrome.tabs.query({ currentWindow: true });
    let change = null;
    // 关掉的是工作页：收养一个新的工作页，否则后续动作全都无处落脚
    if (closingWorkTab && tabs.length) {
      const next = tabs.find((tab) => tab.active) || tabs[0];
      await chrome.tabs.update(next.id, { active: true });
      change = await afterNavigation(next.id);
    }
    return { remaining: tabs.length, change };
  },

  async listTabs() {
    const tabs = await chrome.tabs.query({ currentWindow: true });
    return tabs.map((tab) => ({
      id: tab.id,
      title: tab.title || '',
      // 受限页（chrome:// 等）没有 host 权限，读不到网址
      url: tab.url || t('sys.restrictedUrl'),
      active: Boolean(tab.active),
      isWork: tab.id === state.page.tabId,
    }));
  },
};

/* ========== 消息流 DOM ========== */
function maybeScroll() {
  if (state.ui.autoScroll) els.chat.scrollTop = els.chat.scrollHeight;
}

function appendUserMessage(text) {
  const wrap = document.createElement('div');
  wrap.className = 'msg msg-user';
  const bubble = document.createElement('div');
  bubble.className = 'bubble';
  bubble.textContent = text;
  wrap.appendChild(bubble);
  els.chat.appendChild(wrap);
}

function appendAssistantMessage() {
  const root = document.createElement('div');
  root.className = 'msg msg-ai';
  const content = document.createElement('div');
  content.className = 'ai-content';
  const thinking = document.createElement('div');
  thinking.className = 'thinking';
  thinking.innerHTML = '<i></i><i></i><i></i>';
  root.appendChild(content);
  root.appendChild(thinking);
  els.chat.appendChild(root);
  return { root, content, thinking };
}

function showErrorIn(root, text) {
  const div = document.createElement('div');
  div.className = 'msg-error';
  div.textContent = text;
  root.appendChild(div);
}

// 流程提示行：直接进消息流（不属于任何一条消息），一行浅色小字交代
// 「这条消息重新读了页面」「已压缩此前对话」这类过程事实。返回节点供调用方后续改写。
function appendFlowNote(text) {
  const div = document.createElement('div');
  div.className = 'flow-note';
  div.textContent = text;
  els.chat.appendChild(div);
  return div;
}

// 不挂在任何消息上的错误行（如压缩失败）：与消息内错误同款样式，独立成行
function appendFlowError(text) {
  const div = document.createElement('div');
  div.className = 'msg-error standalone';
  div.textContent = text;
  els.chat.appendChild(div);
}

// 一次性提示条（接口不支持 tools/图片时的降级说明）
function appendNote(root, text) {
  const div = document.createElement('div');
  div.className = 'msg-note';
  div.textContent = text;
  root.appendChild(div);
}

/* ========== 工具调用活动行 ========== */
// 有副作用的动作用 .action 样式强调——用户必须一眼看出 AI 改动了页面
function appendToolActivity(root, text, isAction) {
  const div = document.createElement('div');
  div.className = 'tool-activity running' + (isAction ? ' action' : '');
  div.textContent = text;
  root.appendChild(div);
  return div;
}

function settleToolActivity(div, text, ok) {
  div.classList.remove('running');
  if (!ok) div.classList.add('failed');
  div.textContent = text;
}

// 活动行文案（外壳职责，core 只回传结构化 meta）。phase: run | done | fail
function describeToolActivity(name, args, phase, data = {}) {
  const a = args || {};
  // run/fail 阶段只有调用参数，done 阶段以工具回传的 meta.data 为准
  const ref = data.ref ?? a.ref ?? '?';
  const named = data.name ? ` "${data.name}"` : '';
  const jumped = data.navigated ? t('act.jumped') : '';
  switch (name) {
    case 'find_in_page': {
      const query = phase === 'done' ? data.query : (a.query || '');
      if (phase === 'run') return t('act.find.run', { query });
      if (phase === 'fail') return t('act.find.fail', { query });
      return t(data.total ? 'act.find.done' : 'act.find.none', { query, total: data.total });
    }
    case 'list_elements':
      if (phase === 'run') return t('act.list.run');
      if (phase === 'fail') return t('act.list.fail');
      return t('act.list.done', {
        count: data.count,
        scope: data.scope === 'viewport' ? t('act.list.viewport') : '',
      });
    case 'highlight_element':
      if (phase === 'run') return t('act.highlight.run', { ref });
      if (phase === 'fail') return t('act.highlight.fail', { ref });
      return t('act.highlight.done', { ref, name: named });
    case 'capture_screenshot':
      if (phase === 'run') return t('act.shot.run');
      if (phase === 'fail') return t('act.shot.fail');
      return t('act.shot.done', { count: data.markCount });
    case 'extract_table': {
      const index = data.tableIndex ?? a.table_index ?? '?';
      if (phase === 'run') return t('act.table.run', { index });
      if (phase === 'fail') return t('act.table.fail', { index });
      return t('act.table.done', { index, rows: data.rowCount, cols: data.colCount });
    }
    case 'get_element_html':
      if (phase === 'run') return t('act.html.run', { ref });
      if (phase === 'fail') return t('act.html.fail', { ref });
      return t('act.html.done', { ref, name: named });

    /* —— 动作类：文案更醒目，用户要能一眼看清 AI 对页面做了什么 —— */
    case 'click_element':
      if (phase === 'run') return t('act.click.run', { ref });
      if (phase === 'fail') return t('act.click.fail', { ref });
      return t('act.click.done', { ref, name: named, jumped });
    case 'input_text': {
      const text = String(a.text || '');
      const preview = text.slice(0, 20) + (text.length > 20 ? '…' : '');
      if (phase === 'run') return t('act.input.run', { ref, preview });
      if (phase === 'fail') return t('act.input.fail', { ref });
      return t('act.input.done', { ref, name: named, preview, jumped });
    }
    case 'select_option':
      if (phase === 'run') return t('act.select.run', { ref, option: a.option || '' });
      if (phase === 'fail') return t('act.select.fail', { ref, option: a.option || '' });
      return t('act.select.done', { ref, name: named, value: data.value, jumped });
    case 'press_key': {
      const key = phase === 'done' ? data.key : (a.key || '');
      if (phase === 'run') return t('act.key.run', { key });
      if (phase === 'fail') return t('act.key.fail', { key });
      return t('act.key.done', { key, submitted: data.submitted ? t('act.key.submitted') : '', jumped });
    }
    case 'scroll_page': {
      const label = t('act.scroll.' + (a.direction || 'down'));
      if (phase === 'run') return t('act.scroll.run', { label });
      if (phase === 'fail') return t('act.scroll.fail');
      return t('act.scroll.done', { label });
    }
    case 'navigate':
      if (phase === 'run') return t('act.navigate.run', { url: a.url || '' });
      if (phase === 'fail') return t('act.navigate.fail', { url: a.url || '' });
      return t('act.navigate.done', { title: data.title || a.url || '' });
    case 'go_back':
      if (phase === 'run') return t('act.back.run');
      if (phase === 'fail') return t('act.back.fail');
      return t('act.back.done', { title: data.title || '' });
    case 'refresh':
      if (phase === 'run') return t('act.refresh.run');
      if (phase === 'fail') return t('act.refresh.fail');
      return t('act.refresh.done', { title: data.title || '' });
    case 'open_tab':
      if (phase === 'run') return t('act.openTab.run', { url: a.url || '' });
      if (phase === 'fail') return t('act.openTab.fail');
      return t('act.openTab.done', { title: data.title || a.url || '' });
    case 'switch_tab':
      if (phase === 'run') return t('act.switchTab.run', { id: a.tab_id ?? '?' });
      if (phase === 'fail') return t('act.switchTab.fail');
      return t('act.switchTab.done', { title: data.title || '' });
    case 'close_tab':
      if (phase === 'run') return t('act.closeTab.run');
      if (phase === 'fail') return t('act.closeTab.fail');
      return t('act.closeTab.done');
    case 'list_tabs':
      if (phase === 'run') return t('act.listTabs.run');
      if (phase === 'fail') return t('act.listTabs.fail');
      return t('act.listTabs.done', { count: data.count });
    default:
      return t(`act.generic.${phase === 'run' ? 'run' : phase === 'fail' ? 'fail' : 'done'}`, { name });
  }
}

// 引用块出处校验：命中给定页面文本的引用卡片加「来自当前页面」徽标。
// 实时回合对照 state.page.maskedText，历史回放对照恢复出来的 sentPage 文本。
function applyQuoteBadges(target, pageText) {
  if (!pageText) return;
  target.querySelectorAll('blockquote').forEach((bq) => {
    const quoteText = bq.textContent.trim();
    if (!verifyQuote(quoteText, pageText)) return; // 未命中不背书
    bq.classList.add('quote-verified');
    const badge = document.createElement('button');
    badge.type = 'button';
    badge.className = 'quote-badge';
    badge.textContent = t('ui.quoteBadge');
    badge.title = t('ui.quoteBadgeTitle');
    badge.addEventListener('click', () => {
      state.lastCitation = quoteText;
      badge.textContent = t('ui.quoteStashed');
      setTimeout(() => { badge.textContent = t('ui.quoteBadge'); }, 1200);
    });
    bq.prepend(badge);
  });
}

// 操作行：复制全文（有正文才有）+ 重新生成（只挂在最后一条 AI 回复上，先清掉旧的）
function appendMessageActions(root, contentText, withRegen) {
  if (withRegen) els.chat.querySelectorAll('.btn-regen').forEach((b) => b.remove());
  const actions = document.createElement('div');
  actions.className = 'msg-actions';
  if (contentText) {
    const copyBtn = document.createElement('button');
    copyBtn.type = 'button';
    copyBtn.textContent = t('ui.copyAll');
    copyBtn.addEventListener('click', async () => {
      await navigator.clipboard.writeText(contentText).catch(() => {});
      copyBtn.textContent = t('ui.copied');
      setTimeout(() => { copyBtn.textContent = t('ui.copyAll'); }, 1200);
    });
    actions.appendChild(copyBtn);
  }
  if (withRegen) {
    const regenBtn = document.createElement('button');
    regenBtn.type = 'button';
    regenBtn.className = 'btn-regen';
    regenBtn.textContent = t('ui.regenerate');
    regenBtn.addEventListener('click', handleRegenerate);
    actions.appendChild(regenBtn);
  }
  root.appendChild(actions);
}

// 流结束后的收尾：引用块出处校验 + 操作行。
// 徽标必须在流结束后一次性插入——流式过程中每帧全量重渲会把它抹掉。
// contentEl 为最终回答所在的正文段（工具轮次会产生多段，只校验最后一段）。
function finalizeAssistant(el, msgObj, contentEl) {
  const target = contentEl || el.content;
  if (msgObj.content && state.page.status === 'ok') {
    applyQuoteBadges(target, state.page.maskedText);
  }
  appendMessageActions(el.root, msgObj.content, true);
}

/* ========== 发送与流式 ========== */
// caps 与本轮请求是否带 tools 保持一致，system prompt 才不会指引模型调用不存在的工具
// 会话中页面可能被重新读取多次；历史里只保留最新的那一份全文，
// 更早的全文与差异摘要统一压成一行占位——与截图的 stripImagesFromHistory 同一思路，
// 都是「历史只留最新那一份大块内容」的 token 控制。占位里保留标题，出处仍然可追。
function collapseSupersededPages() {
  let lastFull = -1;
  state.messages.forEach((m, i) => { if (m._page === 'full') lastFull = i; });
  if (lastFull <= 0) return;
  for (let i = 0; i < lastFull; i++) {
    const m = state.messages[i];
    if (!m._page) continue;
    m.content = `${t('sys.pageSuperseded', { title: m._pageTitle || '' })}\n\n${m.displayContent || ''}`;
    delete m._page; // 压过一次就不再重复处理（每轮请求都会调用本函数）
  }
}

// 消息数组 → 出网形态：剔除界面辅助字段，丢掉不该进请求的空回复。
// 必须在压缩裁剪之后调用——boundary 是原始数组的下标，先过滤会让下标漂移。
function sanitizeMessages(messages) {
  return messages
    // 失败的空回复不进入请求；带 tool_calls 而 content 为空的 assistant 必须保留（历史断链会 400）
    .filter((m) => m.role !== 'assistant' || m.content || (m.tool_calls && m.tool_calls.length))
    .map((m) => {
      const out = { role: m.role, content: m.content };
      if (m.tool_calls) out.tool_calls = m.tool_calls;
      if (m.tool_call_id) out.tool_call_id = m.tool_call_id;
      return out; // displayContent 与 `_` 前缀内部字段不出网
    });
}

function buildRequestMessages(caps) {
  collapseSupersededPages();
  return [
    { role: 'system', content: buildSystemPrompt(caps || { tools: false, vision: false, skill: null }) },
    // 压缩过的会话只带「摘要 + 压缩点之后的新消息」；未压缩时原样带全部历史
    ...sanitizeMessages(compactRequestTail(state.messages, state.compact)),
  ];
}

// 「发送 / 停止」按钮：流式产文与压缩摘要都算进行中，两者共用同一个中止槽位
function updateComposer() {
  const busy = state.ui.phase !== 'idle';
  els.btnSend.textContent = t(busy ? 'ui.stop' : 'ui.send');
  els.btnSend.classList.toggle('stop', busy);
}

// 把历史中的截图消息替换为占位文本，返回是否有替换。
// 时机：新截图前（同一请求最多一张真图）与回合收尾（跨回合不携带旧图，控 token）。
function stripImagesFromHistory() {
  let changed = false;
  for (const m of state.messages) {
    if (m._kind === 'tool-image' && Array.isArray(m.content)) {
      m.content = m._placeholder || t('sys.shotOmitted');
      changed = true;
    }
  }
  return changed;
}

// Agent 循环：流式产文 → 模型请求工具 → 执行并回填 → 再次请求，最多 MAX_TOOL_ROUNDS 轮。
// 正常结束 / 出错 / 用户停止都在这里统一收尾。
async function runAgentLoop(el) {
  state.abortController = new AbortController();
  const signal = state.abortController.signal;

  let seg = el.content;       // 当前正文段（工具轮次间会新开段，段间夹活动行）
  let thinking = el.thinking; // 当前「思考中」指示
  let rounds = 0;             // 已完成的工具轮数
  let imagesRetried = false;  // 「接口不支持图片」降级只重试一次

  // 开了页面操作的回合允许更多轮：一次表单填写光是「列元素 + 逐个输入 + 提交 + 验证」
  // 就要八九轮，5 轮必然半途而废
  const actionsOn = Boolean(state.config.actionsEnabled);
  const roundLimit = actionsOn ? MAX_ACTION_ROUNDS : MAX_TOOL_ROUNDS;

  // 技能在回合开始时快照：流式过程中切换/摘除不影响进行中的回合，下一条消息生效
  const skillId = state.skillId;

  const newSegment = () => {
    seg = document.createElement('div');
    seg.className = 'ai-content';
    el.root.appendChild(seg);
    thinking = document.createElement('div');
    thinking.className = 'thinking';
    thinking.innerHTML = '<i></i><i></i><i></i>';
    el.root.appendChild(thinking);
  };

  while (true) {
    // 页面不可读时感知工具无用武之地，但动作工具仍有意义——
    // 用户在 chrome:// 新标签页上说「打开某网址并总结」，靠的就是 open_tab
    const canUseTools = state.page.status === 'ok' || actionsOn;
    const useTools = !state.toolsBroken && canUseTools && rounds < roundLimit;
    const vision = useTools && Boolean(state.config.visionEnabled);
    const actions = useTools && actionsOn;
    const tools = useTools ? buildToolDefs({ vision, actions }) : undefined;
    const requestMessages = buildRequestMessages({ tools: useTools, vision, actions, skill: skillId });
    console.log('[发送内容]', requestMessages); // 验收依据：控制台可核对脱敏后的实际发送内容

    let acc = '';
    let calls = null;
    let rafId = 0;
    const scheduleRender = () => {
      if (rafId) return;
      rafId = requestAnimationFrame(() => {
        rafId = 0;
        seg.innerHTML = renderMarkdown(acc);
        maybeScroll();
      });
    };

    let streamError = null;
    try {
      for await (const ev of streamChat(state.config, requestMessages, { signal, tools })) {
        if (ev.type === 'delta') {
          if (!acc) thinking.remove(); // 首字到达即撤掉「思考中」指示
          acc += ev.text;
          scheduleRender();
        } else if (ev.type === 'tool_calls') {
          calls = ev.calls;
        }
      }
    } catch (err) {
      streamError = err;
    }
    if (rafId) cancelAnimationFrame(rafId);
    thinking.remove();
    seg.innerHTML = acc ? renderMarkdown(acc) : '';

    // 降级路径：400/422 视为「接口不认识请求里的新字段」——先怀疑 tools，再怀疑图片。
    // 各只降一次，5xx/网络错误不吞，照常报错。
    if (
      streamError instanceof LlmError && streamError.kind === 'http' &&
      (streamError.status === 400 || streamError.status === 422) && !signal.aborted
    ) {
      if (tools && !state.toolsBroken) {
        state.toolsBroken = true;
        appendNote(el.root, t('ui.noteToolsDegraded'));
        continue; // 不带 tools 原样重试本轮
      }
      if (!imagesRetried && stripImagesFromHistory()) {
        imagesRetried = true;
        appendNote(el.root, t('ui.noteImageDegraded'));
        continue;
      }
    }

    // 没有工具调用（正常结束/出错/中止）：本段即最终回复。
    // rounds 硬上限兜底：即使请求不带 tools，病态网关仍返回 tool_calls 也不再执行
    if (streamError || !calls || !calls.length || rounds >= roundLimit + 2) {
      const msgObj = { role: 'assistant', content: acc };
      state.messages.push(msgObj);
      const aborted = streamError instanceof LlmError && streamError.kind === 'abort';
      if (streamError && !aborted) {
        // 中止不算错误，保留已生成部分；错误文案同时落在消息上，历史回放时原样重现
        msgObj._error = describeError(streamError);
        showErrorIn(el.root, msgObj._error);
      } else if (!acc && !streamError) {
        seg.textContent = '';
        const note = document.createElement('p');
        note.className = 'md-note';
        note.textContent = t('ui.emptyReply');
        seg.appendChild(note);
      }
      finalizeAssistant(el, msgObj, seg);
      break;
    }

    // 模型请求调用工具：assistant(tool_calls) 落历史，每个调用逐一执行并成对回填 tool 消息
    if (!acc) seg.remove(); // 本轮没有正文，空段不留
    state.messages.push({
      role: 'assistant',
      content: acc,
      tool_calls: calls.map((c) => ({
        id: c.id, type: 'function', function: { name: c.name, arguments: c.arguments },
      })),
    });

    // 同一批调用里一旦发生跳转，后续动作的元素编号已全部失效，不能再盲目执行
    let batchBroken = false;
    for (const call of calls) {
      const isAction = WRITE_TOOL_NAMES.has(call.name);
      // 中止：未执行的调用补占位 tool 消息——tool_calls 必须一一回填，否则历史不合法（下轮 400）
      if (signal.aborted) {
        state.messages.push({ role: 'tool', tool_call_id: call.id, content: t('sys.aborted') });
        continue;
      }
      if (batchBroken) {
        const skipText = t('ui.skipNavigated', { name: call.name });
        state.messages.push({
          role: 'tool', tool_call_id: call.id,
          content: t('sys.batchBroken'),
          // 活动行文案随消息落库：历史回放时不必重算当时的界面（_ 前缀字段不出网）
          _ui: { text: skipText, ok: false, action: isAction },
        });
        settleToolActivity(appendToolActivity(el.root, '', isAction), skipText, false);
        continue;
      }
      let argsForUi = null;
      try { argsForUi = call.arguments ? JSON.parse(call.arguments) : {}; } catch { /* 文案按 null 兜底 */ }
      const row = appendToolActivity(el.root, describeToolActivity(call.name, argsForUi, 'run'), isAction);
      maybeScroll();
      if (call.name === 'capture_screenshot') stripImagesFromHistory(); // 同一请求最多一张真图
      const { toolMessage, followUpMessage, meta } = await dispatchToolCall(call, provider);
      state.messages.push(toolMessage);
      if (followUpMessage) {
        followUpMessage._placeholder = t('sys.shotOmittedMeta', {
          w: meta.data.w, h: meta.data.h, n: meta.data.markCount,
        });
        state.messages.push(followUpMessage);
        attachShotThumbnail(row, followUpMessage);
      }
      const doneText = describeToolActivity(call.name, meta.args || argsForUi, meta.ok ? 'done' : 'fail', meta.data);
      settleToolActivity(row, doneText, meta.ok);
      // 定稿的活动行文案随 tool 消息落库，历史回放据此重建一模一样的活动行
      toolMessage._ui = { text: doneText, ok: meta.ok, action: isAction };
      if (meta.data && meta.data.navigated) batchBroken = true;
      maybeScroll();
    }

    if (signal.aborted) {
      // 中止在工具阶段发生：没有最终回复文本，只挂操作行便于「重新生成」
      finalizeAssistant(el, { role: 'assistant', content: '' }, seg);
      break;
    }

    rounds++;
    if (rounds === roundLimit) {
      // 达到上限：下一轮 useTools 为 false（请求不带 tools），并明确告知模型直接作答
      state.messages.push({
        role: 'user',
        content: t('sys.toolLimit'),
        _kind: 'tool-limit',
      });
    }
    newSegment();
    maybeScroll();
  }

  stripImagesFromHistory(); // 回合收尾：历史不保留任何真图

  state.abortController = null;
  state.ui.phase = 'idle';
  updateComposer();
  maybeScroll();

  // 回合收尾自动落库：正常结束、报错、中止都算——用户消息与已产出的内容都不该丢
  await persistSession();
}

// 截图缩略图：挂在活动行下方，点击展开/收起大图
function attachShotThumbnail(row, followUpMessage) {
  const part = Array.isArray(followUpMessage.content) &&
    followUpMessage.content.find((p) => p.type === 'image_url');
  if (!part) return;
  const img = document.createElement('img');
  img.className = 'tool-thumb';
  img.src = part.image_url.url;
  img.alt = t('ui.shotAlt');
  img.title = t('ui.shotTitle');
  img.addEventListener('click', () => img.classList.toggle('expanded'));
  row.insertAdjacentElement('afterend', img);
}

/* ========== 发送前的页面同步（自动完成，用户不需要点任何按钮） ========== */

// 会话中累计的差异摘要上限：超过这个量说明页面已经改得面目全非，
// 与其继续叠碎片，不如重发一次全文，让模型手上是一份完整的当前页面。
const MAX_DIFF_CHARS = 4000;

/**
 * 每条消息发送前重新快照当前页面（打开侧边栏依然不读取，承诺不变），
 * 再与 state.sentPage（模型上次实际看到的内容）比对，决定本条消息携带什么：
 *   none       页面没变            → 什么都不带，沿用历史里的那一份
 *   diff       同一网址、小幅变化  → 只带几十行差异摘要
 *   full       首次 / 换页 / 大改  → 带最新全文（历史里更早的全文随后被压成占位）
 *   unreadable 当前页读不到        → 不带内容；此前读过页面时交代一句免得模型拿旧页当现状
 * 比对基准是 sentPage 而不是 state.page：AI 操作导致跳转时 state.page 早已换成新页，
 * 只有 sentPage 才知道模型手里还停在哪一页。
 */
async function syncPageForSend() {
  updateContextChip('reading');
  const snap = await snapshotCurrentTab();
  if (!snap) {
    const hadPage = state.page.status === 'ok';
    state.page = { ...initialPage(), status: 'unreadable' };
    updateContextChip();
    return { kind: 'unreadable', changed: hadPage };
  }
  applySnapshot(snap, snap.tabId);
  updateContextChip();

  const sent = state.sentPage;
  const page = state.page;
  if (!sent.text) return { kind: 'full', first: true };
  // 上一条消息告诉过模型「用户切到了读不到的页面」，现在又读到了：哪怕内容与那时一字不差
  // 也要重发一份，否则模型会一直以为用户还停在受限页上
  if (sent.gone) return { kind: 'full', navigated: sent.url !== page.url };
  if (sent.url !== page.url) return { kind: 'full', navigated: true };
  if (sent.text === page.maskedText) return { kind: 'none' };
  const diff = formatTextDiff(sent.text, page.maskedText);
  if (diff && sent.diffChars + diff.length <= MAX_DIFF_CHARS) return { kind: 'diff', diff };
  return { kind: 'full' };
}

// 按同步结果组装本条用户消息的真实内容，并记下「模型已经看到的页面」
function composeSendContent(inputText, sync) {
  if (sync.kind === 'full' || sync.kind === 'diff') {
    const { maskedText, outlineText, url, title } = state.page;
    // 带了差异也算模型已看到最新内容：下次以当前页面为基准比对，差异不会重复累计。
    // 整体重建对象也顺带清掉 gone 标记——模型手上又有页面了
    state.sentPage = {
      text: maskedText, outline: outlineText, url, title,
      diffChars: sync.kind === 'diff' ? state.sentPage.diffChars + sync.diff.length : 0,
    };
  }
  if (sync.kind === 'full') {
    return buildUserContent(
      inputText, state.page.maskedText, state.page.outlineText,
      sync.navigated ? t('prompt.leadSwitched') : ''
    );
  }
  if (sync.kind === 'diff') return buildPageUpdate(inputText, sync.diff);
  if (sync.kind === 'unreadable' && sync.changed) {
    // 记下「已告诉模型页面没了」，等页面重新可读时无条件重发（见 syncPageForSend）
    state.sentPage = { ...state.sentPage, gone: true };
    return `${t('prompt.leadPageGone')}\n\n${inputText}`;
  }
  return inputText;
}

// 只有页面在会话中途真的变了才提示；首次读取由胶囊本身出现即可说明，不再多一行字
function flowNoteFor(sync) {
  if (sync.kind === 'full' && sync.navigated) {
    return t('ui.notePageNavigated', { title: truncateTitle(state.page.title) });
  }
  if (sync.kind === 'full' && !sync.first) return t('ui.notePageReread');
  if (sync.kind === 'diff') return t('ui.notePageUpdated');
  if (sync.kind === 'unreadable' && sync.changed) return t('ui.notePageUnreadable');
  return '';
}

async function handleSend() {
  if (state.ui.phase !== 'idle') return;
  const inputText = els.input.value.trim();
  if (!inputText) return;
  if (!isConfigured()) {
    updateConfigHint();
    openSettings();
    return;
  }

  // /compact 是命令不是提问：不作为用户消息发出，也不读页面
  const command = parseCompactCommand(inputText);
  if (command) {
    els.input.value = '';
    autoSizeInput();
    await runCompact(command.instruction);
    return;
  }

  state.ui.phase = 'streaming';
  updateComposer();
  els.input.value = '';
  autoSizeInput();
  els.welcome.hidden = true;
  state.ui.autoScroll = true;

  // 每条消息都先同步一次页面：变了才带新内容，没变什么都不带（详见 syncPageForSend）
  const sync = await syncPageForSend();
  const contentForRequest = composeSendContent(inputText, sync);

  const userMsg = {
    role: 'user',
    content: contentForRequest,
    displayContent: inputText,
    // 携带页面块的消息打标：下次全量读取后，更早的这些会被压成一行占位
    ...(sync.kind === 'full' || sync.kind === 'diff'
      ? { _page: sync.kind, _pageTitle: state.page.title }
      : {}),
  };
  state.messages.push(userMsg);
  appendUserMessage(inputText);
  const note = flowNoteFor(sync);
  if (note) {
    userMsg._note = note; // 提示行随消息落库：历史回放时仍能看到「页面已切换」这类交代
    appendFlowNote(note);
  }

  const el = appendAssistantMessage();
  maybeScroll();

  await runAgentLoop(el);
}

/* ========== 压缩上下文（/compact） ========== */
// 另调一次模型把此前对话收成一份摘要，之后的请求只带「摘要 + 压缩点之后的新消息」。
// 界面上的气泡与历史回放仍是原文——变的只是请求链（见 core/compact.js）。
// 本能力有损：中间过程、旧工具全文、精确数字都可能在摘要里丢失。
async function runCompact(instruction = '') {
  if (state.ui.phase !== 'idle') return;
  if (!isConfigured()) {
    updateConfigHint();
    openSettings();
    return;
  }
  // 没有用户消息就没有可压的东西：给一行可读提示，不调模型
  if (!state.messages.some((m) => m.role === 'user' && m.displayContent !== undefined)) {
    appendFlowNote(t('ui.compactEmpty'));
    maybeScroll();
    return;
  }

  // 用同一个中止槽位，「停止」按钮才停得住摘要请求
  state.ui.phase = 'compacting';
  updateComposer();
  state.ui.autoScroll = true;
  state.abortController = new AbortController();
  const signal = state.abortController.signal;
  const note = appendFlowNote(t('ui.noteCompacting'));
  maybeScroll();

  // 摘要请求自身也走压缩后的请求链：已压缩过的会话只重发旧摘要 + 压缩点之后的新消息，
  // 否则等于把用户刚要求压掉的原文再发一遍，二次压缩最容易因此超窗失败。
  // 这一轮不注册 tools（与「各段必须与实际注册工具严格一致」同一条铁律）。
  collapseSupersededPages();
  const requestMessages = [
    { role: 'system', content: buildCompactPrompt(instruction) },
    ...sanitizeMessages(compactRequestTail(state.messages, state.compact)),
  ];
  console.log('[发送内容]', requestMessages);

  let summary = '';
  let calls = null;
  let streamError = null;
  try {
    for await (const ev of streamChat(state.config, requestMessages, { signal })) {
      if (ev.type === 'delta') summary += ev.text;
      else if (ev.type === 'tool_calls') calls = ev.calls;
    }
  } catch (err) {
    streamError = err;
  }

  state.abortController = null;
  state.ui.phase = 'idle';
  updateComposer();

  // 失败（含模型不听话仍返回 tool_calls、中止时的半截摘要）一律放弃本次压缩：
  // 原上下文原封不动，对话照常继续。半截摘要比不压缩更危险，绝不将就使用。
  if (streamError || calls || !summary.trim()) {
    note.remove();
    const aborted = streamError instanceof LlmError && streamError.kind === 'abort';
    if (!aborted) appendFlowError(streamError ? describeError(streamError) : t('ui.compactBadReply'));
    maybeScroll();
    return;
  }

  state.compact = buildCompactState(summary, state.messages.length);
  // 压缩后旧的 <页面内容> 不再进请求：清空 sentPage，让下一条用户消息无条件重发当前页全文。
  // 不这么做的话「页面没变就什么都不带」会让模型手里只剩摘要，数字与引用会漂。
  state.sentPage = initialSentPage();
  note.textContent = t('ui.noteCompacted');
  maybeScroll();
  await persistSession();
}

// 重新生成：重发上一条用户消息，替换最后一轮 AI 产物（不重新提取页面）。
// 工具轮次会产生 assistant(tool_calls)/tool/截图跟随消息，必须整条链弹干净，
// 否则残缺的 tool 序列会让下一次请求 400。
async function handleRegenerate() {
  if (state.ui.phase !== 'idle') return;
  if (!state.messages.some((m) => m.role === 'user' && m.displayContent !== undefined)) return;

  // 上一轮若做过有副作用的操作，重放会在页面上再执行一遍，必须先问过用户
  let hasWrite = false;
  for (let i = state.messages.length - 1; i >= 0; i--) {
    const m = state.messages[i];
    if (m.role === 'user' && m.displayContent !== undefined) break;
    if (m.tool_calls && m.tool_calls.some((c) => WRITE_TOOL_NAMES.has(c.function.name))) {
      hasWrite = true;
      break;
    }
  }
  if (hasWrite && !window.confirm(t('ui.regenConfirm'))) {
    return;
  }

  // 从尾部弹出，直到栈顶是用户真实消息（displayContent 仅存在于用户敲入的消息上）
  while (state.messages.length) {
    const last = state.messages[state.messages.length - 1];
    if (last.role === 'user' && last.displayContent !== undefined) break;
    state.messages.pop();
  }
  // 压缩点必须退到「被重放的这条用户消息」之前，否则请求链会把它一起裁掉（400）。
  // 钳到弹完后的数组长度同样不行——slice 仍会切掉栈顶那条用户消息；
  // 这里改完即写回 state.compact，由本轮收尾的 persistSession 落库，
  // 只临时钳不落库会让下一次请求按旧 boundary 切出残缺的 tool 链。
  if (state.compact) {
    state.compact = {
      ...state.compact,
      boundary: Math.min(state.compact.boundary, state.messages.length - 1),
    };
  }
  const aiNodes = els.chat.querySelectorAll('.msg-ai');
  if (aiNodes.length) aiNodes[aiNodes.length - 1].remove(); // 活动行/缩略图都在其内，一并移除

  state.ui.phase = 'streaming';
  updateComposer();
  state.ui.autoScroll = true;

  const el = appendAssistantMessage();
  maybeScroll();

  await runAgentLoop(el);
}

function handleStop() {
  if (state.abortController) state.abortController.abort();
}

function handleNewChat() {
  handleStop();
  state.messages = [];
  state.page = initialPage();
  state.sentPage = initialSentPage();
  state.compact = null;  // 压缩边界与摘要同为会话属性，随会话清空
  state.skillId = null; // 技能是会话属性，随会话清空
  // 会话身份清空：旧会话已在每个回合收尾时落库，这里只是让下一段另起一条记录
  state.sessionId = null;
  state.sessionCreatedAt = 0;
  state.suggest.items = [];
  state.suggest.dismissed.clear(); // 「本会话不再建议」的记忆也随会话清空
  els.chat.querySelectorAll('.msg, .flow-note, .msg-error.standalone').forEach((m) => m.remove());
  els.welcome.hidden = false;
  updateContextChip();
  renderSkillChip();
  renderPlusMenu();
  evaluateSkillSuggestion(); // 对当前页重新评估建议
}

/* ========== 设置抽屉 ========== */
function openSettings() {
  setCtxExpanded(false); // 抽屉与各浮层不并存
  setHistoryOpen(false);
  fillConfigForm();
  els.testResult.textContent = '';
  els.testResult.className = 'test-result';
  els.settings.classList.add('open');
  els.settingsMask.classList.add('show');
}

function closeSettings() {
  els.settings.classList.remove('open');
  els.settingsMask.classList.remove('show');
}

async function handleSaveConfig() {
  state.config = readConfigForm();
  state.toolsBroken = false; // 换了接口/模型，给 tools 一次重新探测的机会
  await storage.set('config', state.config);
  updateConfigHint();
  renderPlusMenu(); // 「页面操作」开关可能在抽屉里被改动，菜单状态同步
  closeSettings();
}

async function handleTestConnection() {
  const config = readConfigForm();
  els.testResult.textContent = t('ui.testRunning');
  els.testResult.className = 'test-result';
  if (!config.baseUrl || !config.model) {
    els.testResult.textContent = t('ui.testNeedFields');
    els.testResult.className = 'test-result err';
    return;
  }
  try {
    await testConnection(config);
    els.testResult.textContent = t('ui.testOk');
    els.testResult.className = 'test-result ok';
  } catch (err) {
    els.testResult.textContent = describeError(err);
    els.testResult.className = 'test-result err';
  }
}

/* ========== 历史会话 ========== */
// 机制总览：
//   - 保存：每个回合收尾（runAgentLoop 结束）把 messages/sentPage/skillId 整体落库；
//     没有任何用户消息不保存；标题取首条用户消息，只在首次保存时确定。
//   - 恢复：整体替换 state 里的会话数据并重建消息流 UI（replayConversation）。
//     state.page 归零——下一条消息照常重读页面并与恢复出的 sentPage 比对，
//     同页未变则什么都不带、换了页自动携带新全文，现有机制无需为历史开特例。
//   - 旧 ref 失效属预期（与 SPA 重渲染过期同一情形），模型经 list_elements 自纠。

// 当前会话落库。落库失败（配额满等）只警告不打断对话——会话仍在内存里。
async function persistSession() {
  const firstUser = state.messages.find((m) => m.role === 'user' && m.displayContent !== undefined);
  if (!firstUser) return; // 没有用户消息的会话不保存
  const now = Date.now();
  if (!state.sessionId) {
    state.sessionId = newSessionId();
    state.sessionCreatedAt = now;
  }
  const record = {
    v: HISTORY_RECORD_VERSION,
    id: state.sessionId,
    createdAt: state.sessionCreatedAt,
    updatedAt: now,
    title: deriveSessionTitle(firstUser.displayContent),
    turns: countTurns(state.messages),
    messages: state.messages, // 回合收尾后的消息数组：截图已替换为占位，`_` 字段供回放
    sentPage: state.sentPage, // 恢复后发送前的页面比对要以它为基准
    skillId: state.skillId,   // 技能是会话属性，随会话保存与恢复
    // 压缩边界与摘要：恢复后界面回放原文，请求链仍走摘要。
    // 缺 compact 的旧记录按未压缩处理，因此 HISTORY_RECORD_VERSION 不必递增。
    compact: state.compact,
  };
  try {
    await historyStore.save(record);
  } catch (err) {
    console.warn('[历史会话] 保存失败', err);
  }
}

// 列表里的相对时间：近的说人话，远的落到日期
function formatHistoryTime(ts) {
  const now = Date.now();
  const diff = now - ts;
  if (diff < 60000) return t('ui.timeJustNow');
  if (diff < 3600000) return t('ui.timeMinutesAgo', { n: Math.floor(diff / 60000) });
  const d = new Date(ts);
  const n = new Date(now);
  if (d.toDateString() === n.toDateString()) {
    return t('ui.timeHoursAgo', { n: Math.floor(diff / 3600000) });
  }
  if (d.toDateString() === new Date(now - 86400000).toDateString()) return t('ui.timeYesterday');
  const parts = { y: d.getFullYear(), m: d.getMonth() + 1, d: d.getDate() };
  return t(parts.y === n.getFullYear() ? 'ui.timeDate' : 'ui.timeDateFull', parts);
}

// 渲染历史列表：只读轻量索引，不加载任何会话正文；全部 textContent 赋值，无注入面。
// 回合进行中列表只读（切换会撕掉正在流式写入的 DOM，删除当前会话同理）。
async function renderHistoryList() {
  const index = await historyStore.list();
  const busy = state.ui.phase !== 'idle';
  els.historyList.innerHTML = '';
  if (busy) {
    const hint = document.createElement('div');
    hint.className = 'history-hint';
    hint.textContent = t('ui.historyStreaming');
    els.historyList.appendChild(hint);
  }
  els.btnClearHistory.hidden = !index.length;
  els.btnClearHistory.disabled = busy;
  if (!index.length) {
    const empty = document.createElement('div');
    empty.className = 'history-empty';
    empty.textContent = t('ui.historyEmpty');
    els.historyList.appendChild(empty);
    return;
  }
  for (const entry of index) {
    const isCurrent = entry.id === state.sessionId;
    const row = document.createElement('div');
    row.className = 'history-item' + (isCurrent ? ' current' : '');
    const main = document.createElement('button');
    main.type = 'button';
    main.className = 'history-item-main';
    main.disabled = busy;
    const title = document.createElement('span');
    title.className = 'history-item-title';
    title.textContent = entry.title;
    const meta = document.createElement('span');
    meta.className = 'history-item-meta';
    const bits = [formatHistoryTime(entry.updatedAt), t('ui.historyTurns', { n: entry.turns })];
    if (isCurrent) bits.unshift(t('ui.historyCurrent'));
    meta.textContent = bits.join(' · ');
    main.append(title, meta);
    main.addEventListener('click', () => loadSession(entry.id));
    const del = document.createElement('button');
    del.type = 'button';
    del.className = 'history-item-del';
    del.textContent = '✕';
    del.title = t('ui.historyDelete');
    del.disabled = busy;
    del.addEventListener('click', () => deleteSession(entry.id));
    row.append(main, del);
    els.historyList.appendChild(row);
  }
}

// 载入一段历史会话：整体替换会话数据并重建消息流
async function loadSession(id) {
  if (state.ui.phase !== 'idle') return;
  if (id === state.sessionId) {
    setHistoryOpen(false); // 点的就是当前会话：什么都不用做
    return;
  }
  const record = await historyStore.load(id);
  if (!record) {
    renderHistoryList(); // 记录缺失（版本不符/被淘汰）：刷新列表让空悬项消失
    return;
  }
  state.messages = record.messages || [];
  state.sentPage = record.sentPage || initialSentPage();
  state.compact = record.compact || null; // 旧记录没有这一项，按未压缩处理
  state.page = initialPage(); // 页面胶囊归零：下一条消息照常重读并与 sentPage 比对
  state.sessionId = record.id;
  state.sessionCreatedAt = record.createdAt;
  state.skillId = record.skillId || null;
  state.suggest.items = [];
  state.suggest.dismissed.clear();

  els.chat.querySelectorAll('.msg, .flow-note, .msg-error.standalone').forEach((m) => m.remove());
  els.welcome.hidden = state.messages.length > 0;
  replayConversation(state.messages, state.compact);
  updateContextChip();
  renderSkillChip();
  renderPlusMenu();
  evaluateSkillSuggestion();
  setHistoryOpen(false);
  els.chat.scrollTop = els.chat.scrollHeight;
}

// 删除一段历史会话；删除的是当前会话时，消息流一并清空（它就是那段会话）
async function deleteSession(id) {
  if (state.ui.phase !== 'idle') return;
  const isCurrent = id === state.sessionId;
  if (!window.confirm(t(isCurrent ? 'ui.historyDeleteCurrentConfirm' : 'ui.historyDeleteConfirm'))) {
    return;
  }
  await historyStore.remove(id);
  if (isCurrent) handleNewChat();
  renderHistoryList();
}

async function clearHistory() {
  if (state.ui.phase !== 'idle') return;
  if (!window.confirm(t('ui.historyClearConfirm'))) return;
  const hadCurrent = Boolean(state.sessionId);
  await historyStore.clear();
  if (hadCurrent) handleNewChat(); // 当前会话的记录也被清掉了，消息流随之清空
  renderHistoryList();
}

/**
 * 从落库的消息数组重建消息流 UI（历史回放）。
 * 只依赖消息数据本身：正文重走 renderMarkdown；活动行用落库时定稿的 _ui 文案
 * （没有 _ui 的 tool 消息当时就没上过屏，如中止占位，回放同样不上屏）；
 * 引用徽标对照恢复出来的 sentPage 文本重新校验；截图在落库前已是占位文本，不回放图片。
 * 回合切分以「用户敲入的消息」为界，与实时渲染的结构一致。
 * 「已压缩此前对话」那行提示不挂在任何消息上（压缩不产生消息），因此不靠 _note 持久化：
 * 有 compact 就在 boundary 对应的位置补插一行，与压缩当时看到的位置一致。
 */
function replayConversation(messages, compact) {
  let root = null;     // 当前 AI 回合的根节点
  let lastSeg = null;  // 回合内最后一个正文段（引用校验的对象）
  let lastText = '';   // 回合内最后一段正文（复制按钮用）

  const closeTurn = (isLast) => {
    if (!root) return;
    if (!root.childElementCount) {
      const note = document.createElement('p');
      note.className = 'md-note';
      note.textContent = t('ui.emptyReply');
      root.appendChild(note);
    }
    if (lastSeg && lastText) applyQuoteBadges(lastSeg, state.sentPage.text);
    appendMessageActions(root, lastText, isLast);
    root = null;
    lastSeg = null;
    lastText = '';
  };

  const compactAt = compact && compact.summary ? compact.boundary : -1;

  messages.forEach((m, i) => {
    // 提示行插在 boundary 那条消息之前；此时上一回合的 root 已在文档里，
    // 随后 closeTurn 追加的操作行落在 root 内部，因此提示行仍显示在该回合之后
    if (i === compactAt) appendFlowNote(t('ui.noteCompacted'));
    if (m.role === 'user' && m.displayContent !== undefined) {
      closeTurn(false);
      appendUserMessage(m.displayContent);
      if (m._note) appendFlowNote(m._note);
      return;
    }
    if (m.role === 'user') return; // 工具上限提示、截图占位等内部消息不上屏
    if (m.role === 'assistant') {
      if (!root) {
        root = document.createElement('div');
        root.className = 'msg msg-ai';
        els.chat.appendChild(root);
      }
      if (m.content) {
        const seg = document.createElement('div');
        seg.className = 'ai-content';
        seg.innerHTML = renderMarkdown(m.content);
        root.appendChild(seg);
        lastSeg = seg;
        lastText = m.content;
      }
      if (m._error) showErrorIn(root, m._error);
      return;
    }
    if (m.role === 'tool' && root && m._ui) {
      settleToolActivity(appendToolActivity(root, '', m._ui.action), m._ui.text, m._ui.ok);
    }
  });
  // 压缩点落在数组末尾（压缩后还没发过新消息）：提示行补在最后
  if (compactAt >= messages.length) appendFlowNote(t('ui.noteCompacted'));
  closeTurn(true);
}

// 历史浮层开合：与页面胶囊浮层同一形态（fixed 覆盖消息流，点外部或 Esc 收起）。
// 打开时才渲染列表——索引读存储，没开就不白读一次。
function setHistoryOpen(open) {
  state.ui.historyOpen = Boolean(open);
  els.historyPop.hidden = !state.ui.historyOpen;
  els.btnHistory.classList.toggle('open', state.ui.historyOpen);
  els.btnHistory.setAttribute('aria-expanded', String(state.ui.historyOpen));
  if (state.ui.historyOpen) renderHistoryList();
}

/* ========== 输入区 ========== */
function autoSizeInput() {
  els.input.style.height = 'auto';
  els.input.style.height = Math.min(els.input.scrollHeight, 160) + 'px';
}

/* ========== 技能（Skill） ========== */
// 技能 = 会话级的声明式提示词包（core/skills.js 登记目录，指令正文在 i18n）。
// 状态只存 state.skillId：不入 config、不持久化；chip / 菜单 hint / 建议条三处联动。

// 设定或摘除会话级技能（id 传 null 即摘除）
function setSkill(id) {
  state.skillId = id || null;
  renderSkillChip();
  renderPlusMenu(); // 菜单项 hint 显示当前技能名
  renderSkillSuggest(); // 有激活技能时建议条隐藏；摘除后已命中的建议立即恢复
}

function renderSkillChip() {
  const on = Boolean(state.skillId);
  els.skillChip.hidden = !on;
  if (on) els.skillChipName.textContent = t(`skill.${state.skillId}.name`);
}

// 渲染建议条：一行一个命中技能；全部 textContent 赋值，无注入面
function renderSkillSuggest() {
  els.skillSuggest.innerHTML = '';
  const items = state.skillId ? [] : state.suggest.items; // 有激活技能时整条隐藏
  els.skillSuggest.hidden = !items.length;
  for (const { id, host } of items) {
    const row = document.createElement('div');
    row.className = 'skill-suggest-row';
    const text = document.createElement('span');
    text.textContent = t('ui.skillSuggestText', { name: t(`skill.${id}.name`) });
    const enable = document.createElement('button');
    enable.type = 'button';
    enable.className = 'skill-suggest-enable';
    enable.textContent = t('ui.skillEnable');
    enable.addEventListener('click', () => setSkill(id));
    const close = document.createElement('button');
    close.type = 'button';
    close.className = 'skill-suggest-close';
    close.textContent = '✕';
    close.title = t('ui.skillSuggestDismiss');
    close.addEventListener('click', () => {
      state.suggest.dismissed.add(`${host}|${id}`); // 同 host + 技能，本会话不再建议
      state.suggest.items = state.suggest.items.filter((it) => !(it.id === id && it.host === host));
      renderSkillSuggest();
    });
    row.append(text, enable, close);
    els.skillSuggest.appendChild(row);
  }
}

// 评估当前激活标签页是否命中技能建议。只读 tab.url 元数据，绝不注入脚本读内容——
// 不违反「发消息才读取页面」的承诺；也不触碰 state.page，与「重新读取」互不干扰。
async function evaluateSkillSuggestion() {
  const tab = await getActiveTab(); // 受限页（chrome:// 等）返回 null → 不建议
  const host = tab ? hostOfUrl(tab.url) : '';
  const matches = host ? matchSkillsByUrl(tab.url) : [];
  state.suggest.items = matches
    .filter((s) => !state.suggest.dismissed.has(`${host}|${s.id}`))
    .map((s) => ({ id: s.id, host }));
  renderSkillSuggest();
}

// tabs 事件的去抖：一次导航会触发多次 onUpdated，200ms 合并成一次评估
let suggestTimer = 0;
function scheduleSuggestEval() {
  clearTimeout(suggestTimer);
  suggestTimer = setTimeout(evaluateSkillSuggestion, 200);
}

/* ========== 「+」功能菜单 ========== */
// 菜单项登记表：后续新增功能（联网搜索、知识库等）在此补一项即可；
// 提供 onSelect 回调后自动变为可点击，onSelect 为 null 时显示为置灰占位。
// icon 为内联 SVG 字符串（16×16、stroke:currentColor），与顶部栏图标同一画风。
// label/hint 均为函数：渲染时才取词，因而语言切换后重渲即生效。
// keepOpen 为真的项点击后菜单不关闭（如「绑定 Skill」进入二级列表）。
// disabled 为函数时按当前状态置灰（如回合/压缩进行中不能再压一次），菜单每次打开都重渲取新值。
const COMPOSER_MENU_ITEMS = [
  {
    id: 'skill',
    label: () => t('ui.menuSkill'),
    hint: () => (state.skillId ? t(`skill.${state.skillId}.name`) : t('ui.menuSkillNone')),
    active: () => Boolean(state.skillId),
    icon: '<svg viewBox="0 0 16 16" width="16" height="16" fill="none" stroke="currentColor" stroke-width="1.4" aria-hidden="true"><path d="M8 1.8l1.5 4.7 4.7 1.5-4.7 1.5L8 14.2 6.5 9.5 1.8 8l4.7-1.5z"/></svg>',
    keepOpen: true,
    onSelect: () => {
      state.ui.plusMenuView = 'skills';
      renderPlusMenu();
    },
  },
  {
    id: 'web-search',
    label: () => t('ui.menuWebSearch'),
    hint: () => t('ui.menuComingSoon'),
    icon: '<svg viewBox="0 0 16 16" width="16" height="16" fill="none" stroke="currentColor" stroke-width="1.4" aria-hidden="true"><circle cx="8" cy="8" r="6.2"/><ellipse cx="8" cy="8" rx="2.8" ry="6.2"/><path d="M1.8 8h12.4"/></svg>',
    onSelect: null,
  },
  {
    id: 'knowledge-base',
    label: () => t('ui.menuKnowledge'),
    hint: () => t('ui.menuComingSoon'),
    icon: '<svg viewBox="0 0 16 16" width="16" height="16" fill="none" stroke="currentColor" stroke-width="1.4" aria-hidden="true"><path d="M2.5 3.2c1.8-1 3.7-1 5.5 0 1.8-1 3.7-1 5.5 0v9.6c-1.8-1-3.7-1-5.5 0-1.8-1-3.7-1-5.5 0z"/><path d="M8 3.2v9.6"/></svg>',
    onSelect: null,
  },
  {
    id: 'page-actions',
    label: () => t('ui.menuPageActions'),
    // hint 支持函数形式：随开关状态实时变化
    hint: () => t(state.config.actionsEnabled ? 'ui.menuOn' : 'ui.menuOff'),
    active: () => Boolean(state.config.actionsEnabled),
    icon: '<svg viewBox="0 0 16 16" width="16" height="16" fill="none" stroke="currentColor" stroke-width="1.4" aria-hidden="true"><rect x="1.8" y="2.5" width="12.4" height="8.2" rx="1"/><path d="M8 10.7v2.3M5.2 13.5h5.6"/><path d="M6.8 5.2l3.4 1.5-1.6.6-.6 1.6z"/></svg>',
    onSelect: togglePageActions,
  },
  {
    id: 'compact',
    label: () => t('ui.menuCompact'),
    // hint 直接写命令名：菜单同时是 /compact 这条输入框命令的说明书
    hint: () => t('ui.menuCompactHint'),
    // 不标 active：压缩是可以反复执行的一次性动作，不是「开着」的状态开关；
    // 「这段会话已压缩过」由消息流里那行提示交代（回放时也在）
    disabled: () => state.ui.phase !== 'idle', // 回合或上一次压缩进行中不可再压
    icon: '<svg viewBox="0 0 16 16" width="16" height="16" fill="none" stroke="currentColor" stroke-width="1.4" aria-hidden="true"><path d="M2.2 8h11.6"/><path d="M8 1.8v3.6M6.3 3.8L8 5.4l1.7-1.6"/><path d="M8 14.2v-3.6M6.3 12.2L8 10.6l1.7 1.6"/></svg>',
    onSelect: () => runCompact(),
  },
];

// 「页面操作」快捷开关：与设置抽屉里的 cfg-actions 共用同一个 config 字段，天然同步。
// 开启是一次有实际后果的授权，先把风险说清楚再放行；关闭则不设阻拦。
async function togglePageActions() {
  const turningOn = !state.config.actionsEnabled;
  if (turningOn && !window.confirm(t('ui.actionsConfirm'))) {
    return;
  }
  state.config = { ...state.config, actionsEnabled: turningOn };
  await storage.set('config', state.config);
  renderPlusMenu();
}

// 渲染菜单项：label/hint 取自文案目录，无用户输入，用 textContent/常量 SVG 拼装
function renderPlusMenu() {
  els.plusMenu.classList.toggle('skills', state.ui.plusMenuView === 'skills');
  els.plusMenu.innerHTML = '';
  if (state.ui.plusMenuView === 'skills') {
    renderSkillMenu();
    return;
  }
  for (const item of COMPOSER_MENU_ITEMS) {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'plus-menu-item';
    btn.setAttribute('role', 'menuitem');
    btn.disabled =
      typeof item.onSelect !== 'function' ||
      (typeof item.disabled === 'function' && item.disabled());
    if (typeof item.active === 'function' && item.active()) btn.classList.add('active');
    btn.innerHTML = item.icon;
    const label = document.createElement('span');
    label.className = 'plus-menu-label';
    label.textContent = typeof item.label === 'function' ? item.label() : item.label;
    btn.appendChild(label);
    const hintText = typeof item.hint === 'function' ? item.hint() : item.hint;
    if (hintText) {
      const hint = document.createElement('span');
      hint.className = 'plus-menu-hint';
      hint.textContent = hintText;
      btn.appendChild(hint);
    }
    if (!btn.disabled) {
      btn.addEventListener('click', (e) => {
        // 菜单内点击不冒泡到 document 的外点关闭监听：keepOpen 项会重渲菜单、
        // 把被点按钮摘出文档，冒泡后 closest 判定失败会被误当成「点在菜单外」
        e.stopPropagation();
        if (!item.keepOpen) setPlusMenuOpen(false);
        item.onSelect();
      });
    }
    els.plusMenu.appendChild(btn);
  }
}

// 技能二级列表：标题 + 返回 + 「不使用技能」 + 预置技能（当前项高亮并带「使用中」胶囊）
function renderSkillMenu() {
  const title = document.createElement('span');
  title.className = 'plus-menu-title';
  title.textContent = t('ui.skillPickTitle'); // DOM 取词，不沿用 ::before 硬编码做法
  els.plusMenu.appendChild(title);
  const addItem = (labelText, selected, hintText, descText, onClick) => {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'plus-menu-item';
    btn.setAttribute('role', 'menuitem');
    if (selected) btn.classList.add('active');
    if (descText) btn.title = descText;
    const label = document.createElement('span');
    label.className = 'plus-menu-label';
    label.textContent = labelText;
    btn.appendChild(label);
    if (hintText) {
      const hint = document.createElement('span');
      hint.className = 'plus-menu-hint';
      hint.textContent = hintText;
      btn.appendChild(hint);
    }
    btn.addEventListener('click', (e) => {
      e.stopPropagation(); // 同上：「返回」会重渲菜单，冒泡会被误判为外点而关闭
      onClick();
    });
    els.plusMenu.appendChild(btn);
  };
  addItem(t('ui.skillBack'), false, '', '', () => {
    state.ui.plusMenuView = 'root';
    renderPlusMenu();
  });
  addItem(t('ui.skillNone'), !state.skillId, '', '', () => {
    setSkill(null);
    setPlusMenuOpen(false);
  });
  for (const s of listSkills()) {
    const inUse = state.skillId === s.id;
    addItem(t(`skill.${s.id}.name`), inUse, inUse ? t('ui.skillInUse') : '', t(`skill.${s.id}.desc`), () => {
      setSkill(s.id);
      setPlusMenuOpen(false);
    });
  }
}

function setPlusMenuOpen(open) {
  state.ui.plusMenuOpen = open;
  // 关闭时把视图复位到根菜单，下次打开不会残留技能列表
  if (!open && state.ui.plusMenuView !== 'root') {
    state.ui.plusMenuView = 'root';
    renderPlusMenu();
  }
  // 打开时重渲一次：hint 与置灰状态（如「压缩上下文」是否可用）都按当下取值
  if (open) renderPlusMenu();
  els.plusMenu.classList.toggle('open', open);
  els.btnPlus.classList.toggle('open', open);
  els.btnPlus.setAttribute('aria-expanded', String(open));
}

/* ========== 事件绑定 ========== */
// 把 CSV 文本落盘为 .csv 文件：前置 UTF-8 BOM，保证 Excel 打开中文不乱码；
// 文件名取当前页面标题（清掉路径非法字符与空白），读不到标题时用 table 兜底
function downloadCsv(text) {
  const base =
    ((state.page && state.page.title) || '')
      .replace(/[\\/:*?"<>|\s]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 40) || 'table';
  const blob = new Blob(['\uFEFF' + text], { type: 'text/csv;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = `${base}.csv`;
  a.click();
  // 延迟回收：click 后立即 revoke 在部分场景会截断尚未开始的下载
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

function bindEvents() {
  els.btnSend.addEventListener('click', () => {
    if (state.ui.phase !== 'idle') handleStop(); // 流式与压缩都由同一个 abortController 停住
    else handleSend();
  });

  els.btnPlus.addEventListener('click', () => setPlusMenuOpen(!state.ui.plusMenuOpen));

  // 点击菜单区域以外任意位置关闭菜单（按钮自身的点击由上面的开关处理）
  document.addEventListener('click', (e) => {
    if (state.ui.plusMenuOpen && !e.target.closest('.composer-tools')) setPlusMenuOpen(false);
    // 浮层之外任意点击都收起（胶囊/历史钮自身的点击已 stopPropagation）
    if (state.ui.ctxExpanded && !e.target.closest('.ctx-detail')) setCtxExpanded(false);
    if (state.ui.historyOpen && !e.target.closest('.history-pop')) setHistoryOpen(false);
  });
  document.addEventListener('keydown', (e) => {
    if (e.key !== 'Escape') return;
    if (state.ui.plusMenuOpen) setPlusMenuOpen(false);
    if (state.ui.ctxExpanded) setCtxExpanded(false);
    if (state.ui.historyOpen) setHistoryOpen(false);
  });

  els.input.addEventListener('input', autoSizeInput);
  els.input.addEventListener('keydown', (e) => {
    // isComposing：中文输入法候选态的回车不触发发送
    if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) {
      e.preventDefault();
      handleSend();
    }
  });

  els.btnNewChat.addEventListener('click', handleNewChat);

  // 页面胶囊：点开/收起「本次读取了什么」浮层
  els.btnContext.addEventListener('click', (e) => {
    e.stopPropagation();
    setHistoryOpen(false); // 与历史浮层不并存
    setCtxExpanded(!state.ui.ctxExpanded);
  });

  els.btnSettings.addEventListener('click', openSettings);
  els.btnGotoSettings.addEventListener('click', openSettings);
  els.btnCloseSettings.addEventListener('click', closeSettings);
  els.settingsMask.addEventListener('click', closeSettings);

  // 历史会话浮层：点按钮开合（stopPropagation 让下面的外点关闭监听不误判）
  els.btnHistory.addEventListener('click', (e) => {
    e.stopPropagation();
    setCtxExpanded(false); // 与页面胶囊浮层不并存
    setHistoryOpen(!state.ui.historyOpen);
  });
  els.btnClearHistory.addEventListener('click', clearHistory);
  els.btnSave.addEventListener('click', handleSaveConfig);
  els.btnTest.addEventListener('click', handleTestConnection);

  // 语言即时生效并落盘（不等「保存」）：抽屉里其他字段还没填完时也能先把界面语言换过来
  els.cfgLocale.addEventListener('change', async () => {
    state.config = { ...state.config, locale: els.cfgLocale.value };
    await storage.set('config', state.config);
    applyLocale(state.config.locale);
  });

  // 用户上滚暂停自动滚动，滚回底部恢复
  els.chat.addEventListener('scroll', () => {
    const nearBottom =
      els.chat.scrollHeight - els.chat.scrollTop - els.chat.clientHeight < 40;
    state.ui.autoScroll = nearBottom;
  });

  // 代码块头部按钮（复制 / csv 下载）：内容随流式重渲不断重建，用事件委托
  els.chat.addEventListener('click', async (e) => {
    const btn = e.target.closest('[data-role="copy-code"], [data-role="download-csv"]');
    if (!btn) return;
    const codeEl = btn.closest('.md-codeblock')?.querySelector('pre code');
    if (!codeEl) return;
    if (btn.dataset.role === 'copy-code') {
      await navigator.clipboard.writeText(codeEl.textContent).catch(() => {});
      btn.textContent = t('md.copied');
      setTimeout(() => { btn.textContent = t('md.copy'); }, 1200);
    } else {
      downloadCsv(codeEl.textContent);
      btn.textContent = t('md.downloaded');
      setTimeout(() => { btn.textContent = t('md.download'); }, 1200);
    }
  });

  // 技能 chip 的 ✕：摘除会话级技能
  els.skillChipRemove.addEventListener('click', () => setSkill(null));

  // 标签页切换 / 导航 → 重新评估技能建议（只读 tab.url 元数据，绝不注入脚本）；
  // onUpdated 只关心 URL 变化（含 SPA pushState），其余 changeInfo 一律忽略
  chrome.tabs.onActivated.addListener(scheduleSuggestEval);
  chrome.tabs.onUpdated.addListener((tabId, changeInfo) => {
    if (changeInfo.url) scheduleSuggestEval();
  });
}

/* ========== 启动（只读配置，不读页面、不发网络请求） ========== */
(async function init() {
  await loadConfig();
  renderLocaleOptions();
  applyLocale(state.config.locale); // 静态文案 + 页面胶囊 + 菜单 + 发送按钮一并按语言渲染
  updateConfigHint();
  bindEvents();
  // 打开面板时若已停在名单内的页面，直接给出技能建议：只查 tab 元数据，
  // 不注入脚本、不发网络请求，「打开侧边栏不读取页面」的承诺不受影响
  evaluateSkillSuggestion();
})();
