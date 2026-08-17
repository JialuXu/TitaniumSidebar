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
import { formatOutline } from './core/format.js';
import { maskSensitive } from './core/masker.js';
import { buildSystemPrompt, buildUserContent } from './core/prompt.js';
import { streamChat, testConnection, LlmError } from './core/llm-client.js';
import { renderMarkdown } from './core/markdown.js';
import { verifyQuote } from './core/citation.js';
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
};

/* ========== 全局状态 ========== */
const DEFAULT_CONFIG = {
  baseUrl: '', model: '', apiKey: '',
  maskEnabled: true,
  visionEnabled: false,
  actionsEnabled: false, // 允许页面操作（点击/输入/跳转），默认关闭
  locale: '',            // 界面与模型文案的语言；空串=跟随浏览器（首次启动时判定）
};

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
    injected: false,         // 页面内容是否已注入过消息历史（同会话不重复注入）
    refreshRequested: false, // 用户点了「重新读取」或页面已跳转，下一条消息重新提取
  };
}

const state = {
  config: { ...DEFAULT_CONFIG },
  // 消息历史：content 是真实请求内容（首条 user 含 <页面内容> 块），
  // displayContent 只存用户敲入的原话用于渲染（不把 12000 字页面文本刷进 UI）。
  // 工具调用轮次会追加 assistant(tool_calls)/tool/截图跟随消息，`_` 前缀字段发请求前剔除。
  messages: [],
  page: initialPage(),
  ui: { phase: 'idle', autoScroll: true, ctxExpanded: false, plusMenuOpen: false }, // phase: idle | streaming
  abortController: null,
  toolsBroken: false, // 接口不支持 tools（收到过 400/422），本会话降级纯文本；保存配置时重置
  lastCitation: '', // 点击引用徽标暂存的原文（生产版可扩展为定位高亮）
};

/* ========== DOM 引用 ========== */
const els = {};
[
  'btn-new-chat', 'btn-settings', 'context-wrap', 'ctx-text', 'ctx-badge', 'btn-refresh',
  'ctx-caret', 'ctx-detail', 'ctx-detail-url', 'ctx-detail-outline', 'ctx-detail-text',
  'chat', 'welcome', 'config-hint', 'btn-goto-settings', 'input', 'btn-send',
  'btn-plus', 'plus-menu',
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
  updateContextBar();
  updateComposer();
  renderPlusMenu();
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

/* ========== 上下文状态条 ========== */
// 英文标题同宽度下字数更多，上限相应放宽
function truncateTitle(title, max = document.documentElement.lang === 'en' ? 34 : 22) {
  if (!title) return t('ui.untitled');
  return title.length > max ? title.slice(0, max) + '…' : title;
}

// 展开/折叠「已读取内容」详情面板（仅 status 为 ok 时可展开）
function setCtxExpanded(expanded) {
  state.ui.ctxExpanded = expanded && state.page.status === 'ok';
  els.ctxDetail.classList.toggle('open', state.ui.ctxExpanded);
  els.ctxCaret.classList.toggle('open', state.ui.ctxExpanded);
}

function updateContextBar(transient) {
  const { page } = state;
  // 空闲态（尚未发过消息）整卡隐藏，读取中/已读取/不可读时才显示
  els.contextWrap.hidden =
    transient !== 'reading' && page.status !== 'ok' && page.status !== 'unreadable';
  els.ctxBadge.hidden = true;
  els.btnRefresh.hidden = true;
  els.ctxCaret.hidden = true;
  els.ctxText.classList.remove('clickable');

  if (transient === 'reading') {
    els.ctxText.textContent = t('ui.ctxReading');
    setCtxExpanded(false);
    return;
  }

  const suffix = page.refreshRequested ? t('ui.ctxRefreshSuffix') : '';

  if (page.status === 'ok') {
    const elements = page.elementCount ? t('ui.ctxElements', { n: page.elementCount }) : '';
    els.ctxText.textContent = t('ui.ctxRead', {
      title: truncateTitle(page.title), chars: page.maskedText.length, elements, suffix,
    });
    els.ctxText.title = t('ui.ctxTitleHint', { title: page.title || '' });
    els.ctxText.classList.add('clickable');
    els.ctxCaret.hidden = false;
    els.btnRefresh.hidden = false;
    // 详情面板内容与当前读取结果保持同步（textContent 赋值，无注入风险）
    els.ctxDetailUrl.textContent = page.url;
    els.ctxDetailOutline.textContent = page.outlineText;
    els.ctxDetailOutline.hidden = !page.outlineText;
    els.ctxDetailText.textContent = page.maskedText;
    setCtxExpanded(state.ui.ctxExpanded); // 内容更新后维持原展开状态
    const hits = page.hits;
    const total = hits ? hits.idCard + hits.bankCard + hits.phone : 0;
    if (total > 0) {
      els.ctxBadge.textContent = t('ui.maskBadge', { n: total });
      els.ctxBadge.title = t('ui.maskBadgeTitle', hits);
      els.ctxBadge.hidden = false;
    }
  } else if (page.status === 'unreadable') {
    els.ctxText.textContent = t('ui.ctxUnreadable', { suffix });
    els.ctxText.title = '';
    els.btnRefresh.hidden = false;
    setCtxExpanded(false);
  } else {
    els.ctxText.textContent = t('ui.ctxIdle');
    els.ctxText.title = '';
    setCtxExpanded(false);
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
  const result = await injectFunc(tab.id, snapshotPage, {
    mode: 'full', maxTextLen: 12000, maxElements: 1500, i18n: injectedStrings(),
  });
  if (!result || !result.ok || !result.text) return null;
  return { ...result, tabId: tab.id };
}

// 把一次 full 快照写入 state.page（脱敏 + 命中合并）。
// 首条消息的读取与动作导致跳转后的重建共用这一份，避免两处规则漂移。
function applySnapshot(snap, tabId, { refreshRequested = false } = {}) {
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
    injected: true,
    refreshRequested,
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
// 刻意置 refreshRequested——新页全文不在本回合塞给模型（回合内 token 会爆），
// 而是复用既有的「重新读取」机制，由下一条用户消息携带。
async function rebuildPageAfterNavigation(tab) {
  if (!tab || !tab.id || isRestrictedUrl(tab.url)) {
    state.page = { ...state.page, status: 'unreadable', tabId: tab && tab.id ? tab.id : state.page.tabId, refreshRequested: true };
    updateContextBar();
    return { navigated: true, restricted: true };
  }
  const snap = await injectFunc(tab.id, snapshotPage, {
    mode: 'full', maxTextLen: 12000, maxElements: 1500, i18n: injectedStrings(),
  });
  if (!snap || !snap.ok) {
    state.page = { ...state.page, status: 'unreadable', tabId: tab.id, refreshRequested: true };
    updateContextBar();
    return { navigated: true, restricted: true };
  }
  applySnapshot(snap, tab.id, { refreshRequested: true });
  updateContextBar();
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
    if (wait > 0) await new Promise((r) => setTimeout(r, wait));
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

// 流结束后的收尾：引用块出处校验 + 操作行。
// 徽标必须在流结束后一次性插入——流式过程中每帧全量重渲会把它抹掉。
// contentEl 为最终回答所在的正文段（工具轮次会产生多段，只校验最后一段）。
function finalizeAssistant(el, msgObj, contentEl) {
  const target = contentEl || el.content;
  if (msgObj.content && state.page.status === 'ok') {
    target.querySelectorAll('blockquote').forEach((bq) => {
      const quoteText = bq.textContent.trim();
      if (!verifyQuote(quoteText, state.page.maskedText)) return; // 未命中不背书
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

  // 操作行：复制全文 + 重新生成（重新生成只对最后一条 AI 回复有意义，先清掉旧的）
  els.chat.querySelectorAll('.btn-regen').forEach((b) => b.remove());
  const actions = document.createElement('div');
  actions.className = 'msg-actions';
  if (msgObj.content) {
    const copyBtn = document.createElement('button');
    copyBtn.type = 'button';
    copyBtn.textContent = t('ui.copyAll');
    copyBtn.addEventListener('click', async () => {
      await navigator.clipboard.writeText(msgObj.content).catch(() => {});
      copyBtn.textContent = t('ui.copied');
      setTimeout(() => { copyBtn.textContent = t('ui.copyAll'); }, 1200);
    });
    actions.appendChild(copyBtn);
  }
  const regenBtn = document.createElement('button');
  regenBtn.type = 'button';
  regenBtn.className = 'btn-regen';
  regenBtn.textContent = t('ui.regenerate');
  regenBtn.addEventListener('click', handleRegenerate);
  actions.appendChild(regenBtn);
  el.root.appendChild(actions);
}

/* ========== 发送与流式 ========== */
// caps 与本轮请求是否带 tools 保持一致，system prompt 才不会指引模型调用不存在的工具
function buildRequestMessages(caps) {
  return [
    { role: 'system', content: buildSystemPrompt(caps || { tools: false, vision: false }) },
    ...state.messages
      // 失败的空回复不进入请求；带 tool_calls 而 content 为空的 assistant 必须保留（历史断链会 400）
      .filter((m) => m.role !== 'assistant' || m.content || (m.tool_calls && m.tool_calls.length))
      .map((m) => {
        const out = { role: m.role, content: m.content };
        if (m.tool_calls) out.tool_calls = m.tool_calls;
        if (m.tool_call_id) out.tool_call_id = m.tool_call_id;
        return out; // displayContent 与 `_` 前缀内部字段不出网
      }),
  ];
}

function updateComposer() {
  const streaming = state.ui.phase === 'streaming';
  els.btnSend.textContent = t(streaming ? 'ui.stop' : 'ui.send');
  els.btnSend.classList.toggle('stop', streaming);
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
    const requestMessages = buildRequestMessages({ tools: useTools, vision, actions });
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
        showErrorIn(el.root, describeError(streamError)); // 中止不算错误，保留已生成部分
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
        state.messages.push({
          role: 'tool', tool_call_id: call.id,
          content: t('sys.batchBroken'),
        });
        settleToolActivity(
          appendToolActivity(el.root, '', isAction),
          t('ui.skipNavigated', { name: call.name }),
          false
        );
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
      settleToolActivity(
        row,
        describeToolActivity(call.name, meta.args || argsForUi, meta.ok ? 'done' : 'fail', meta.data),
        meta.ok
      );
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

async function handleSend() {
  if (state.ui.phase !== 'idle') return;
  const inputText = els.input.value.trim();
  if (!inputText) return;
  if (!isConfigured()) {
    updateConfigHint();
    openSettings();
    return;
  }

  state.ui.phase = 'streaming';
  updateComposer();
  els.input.value = '';
  autoSizeInput();
  els.welcome.hidden = true;
  state.ui.autoScroll = true;

  // 首条消息或用户点了「重新读取」时才执行页面快照
  let contentForRequest;
  if (!state.page.injected || state.page.refreshRequested) {
    updateContextBar('reading');
    const snap = await snapshotCurrentTab();
    if (snap) {
      applySnapshot(snap, snap.tabId);
      contentForRequest = buildUserContent(inputText, state.page.maskedText, state.page.outlineText);
    } else {
      // 快照失败也置 injected，避免同会话每条消息都无谓重试；可用「重新读取」手动再试
      state.page = { ...initialPage(), status: 'unreadable', injected: true };
      contentForRequest = buildUserContent(inputText, null);
    }
    updateContextBar();
  } else {
    // 同一会话后续消息不重复注入页面内容，沿用历史里的那一份
    contentForRequest = inputText;
  }

  state.messages.push({ role: 'user', content: contentForRequest, displayContent: inputText });
  appendUserMessage(inputText);

  const el = appendAssistantMessage();
  maybeScroll();

  await runAgentLoop(el);
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
  els.chat.querySelectorAll('.msg').forEach((m) => m.remove());
  els.welcome.hidden = false;
  updateContextBar();
}

/* ========== 设置抽屉 ========== */
function openSettings() {
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

/* ========== 输入区 ========== */
function autoSizeInput() {
  els.input.style.height = 'auto';
  els.input.style.height = Math.min(els.input.scrollHeight, 160) + 'px';
}

/* ========== 「+」功能菜单 ========== */
// 菜单项登记表：后续新增功能（绑定 Skill、联网搜索、知识库等）在此补一项即可；
// 提供 onSelect 回调后自动变为可点击，onSelect 为 null 时显示为置灰占位。
// icon 为内联 SVG 字符串（16×16、stroke:currentColor），与顶部栏图标同一画风。
// label/hint 均为函数：渲染时才取词，因而语言切换后重渲即生效。
const COMPOSER_MENU_ITEMS = [
  {
    id: 'skill',
    label: () => t('ui.menuSkill'),
    hint: () => t('ui.menuComingSoon'),
    icon: '<svg viewBox="0 0 16 16" width="16" height="16" fill="none" stroke="currentColor" stroke-width="1.4" aria-hidden="true"><path d="M8 1.8l1.5 4.7 4.7 1.5-4.7 1.5L8 14.2 6.5 9.5 1.8 8l4.7-1.5z"/></svg>',
    onSelect: null,
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
  els.plusMenu.innerHTML = '';
  for (const item of COMPOSER_MENU_ITEMS) {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'plus-menu-item';
    btn.setAttribute('role', 'menuitem');
    btn.disabled = typeof item.onSelect !== 'function';
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
      btn.addEventListener('click', () => {
        setPlusMenuOpen(false);
        item.onSelect();
      });
    }
    els.plusMenu.appendChild(btn);
  }
}

function setPlusMenuOpen(open) {
  state.ui.plusMenuOpen = open;
  els.plusMenu.classList.toggle('open', open);
  els.btnPlus.classList.toggle('open', open);
  els.btnPlus.setAttribute('aria-expanded', String(open));
}

/* ========== 事件绑定 ========== */
function bindEvents() {
  els.btnSend.addEventListener('click', () => {
    if (state.ui.phase === 'streaming') handleStop();
    else handleSend();
  });

  els.btnPlus.addEventListener('click', () => setPlusMenuOpen(!state.ui.plusMenuOpen));

  // 点击菜单区域以外任意位置关闭菜单（按钮自身的点击由上面的开关处理）
  document.addEventListener('click', (e) => {
    if (state.ui.plusMenuOpen && !e.target.closest('.composer-tools')) setPlusMenuOpen(false);
  });
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && state.ui.plusMenuOpen) setPlusMenuOpen(false);
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
  els.btnRefresh.addEventListener('click', () => {
    state.page.refreshRequested = true;
    updateContextBar();
  });

  // 点击状态条文字或箭头，展开/折叠已读取内容详情
  const toggleCtxDetail = () => {
    if (state.page.status !== 'ok') return;
    setCtxExpanded(!state.ui.ctxExpanded);
  };
  els.ctxText.addEventListener('click', toggleCtxDetail);
  els.ctxCaret.addEventListener('click', toggleCtxDetail);

  els.btnSettings.addEventListener('click', openSettings);
  els.btnGotoSettings.addEventListener('click', openSettings);
  els.btnCloseSettings.addEventListener('click', closeSettings);
  els.settingsMask.addEventListener('click', closeSettings);
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

  // 代码块复制按钮：内容随流式重渲不断重建，用事件委托
  els.chat.addEventListener('click', async (e) => {
    const btn = e.target.closest('[data-role="copy-code"]');
    if (!btn) return;
    const codeEl = btn.closest('.md-codeblock')?.querySelector('pre code');
    if (!codeEl) return;
    await navigator.clipboard.writeText(codeEl.textContent).catch(() => {});
    btn.textContent = t('md.copied');
    setTimeout(() => { btn.textContent = t('md.copy'); }, 1200);
  });
}

/* ========== 启动（只读配置，不读页面、不发网络请求） ========== */
(async function init() {
  await loadConfig();
  renderLocaleOptions();
  applyLocale(state.config.locale); // 静态文案 + 状态条 + 菜单 + 发送按钮一并按语言渲染
  updateConfigHint();
  bindEvents();
})();
