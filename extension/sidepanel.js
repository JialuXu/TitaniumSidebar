// sidepanel.js —— 扩展外壳：UI 渲染与状态、chrome.* API 接线、把 core 模块串起来。
// 业务逻辑（提取/脱敏/组装/调用/渲染/校验）全部在 core/，本文件不实现任何业务规则。

import { snapshotPage } from './core/snapshot.js';
import { highlightElement } from './core/highlight.js';
import { performAction } from './core/actions.js';
import { waitForSettle } from './core/settle.js';
import { runAgentTurn, requestCompaction, measureNextRequest, describeError } from './core/agent.js';
import { describeTrace } from './core/activity.js';
import { annotateScreenshot } from './core/annotate.js';
import { BUDGETS } from './core/format.js';
import { maskSensitive } from './core/masker.js';
import { hasUserInput, lastTurnHasWrites, rewindLastTurn } from './core/conversation.js';
import {
  initialSentPage, decidePageSync, composeSendContent, describeSyncNote,
  initialPage, pageFromSnapshot, fullSnapshotArgs, MAX_ELEMENTS, SETTLE, loadingOf,
} from './core/page-sync.js';
import { parseCompactCommand } from './core/compact.js';
import { testConnection, isContextOverflow } from './core/llm-client.js';
import { formatTokens, LEVEL_RANK } from './core/context-meter.js';
import {
  normalizeConfig, activeProfile, emptyProfile, profileLabel, buildSettingsExport, parseSettingsImport,
  parseContextWindow, formatContextWindow, mergeImportedConfig,
} from './core/settings.js';
import { renderMarkdown } from './core/markdown.js';
import { verifyQuote, buildQuoteCorpus } from './core/citation.js';
import { listSkills, suggestSkills, suggestionKey } from './core/skills.js';
import {
  createHistoryStore, HistoryTooLargeError, newSessionId, buildSessionRecord, formatHistoryTime,
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

// 历史会话存储：索引与记录分键存放，超过 50 条或 8 成配额自动淘汰最旧（见 core/history.js）。
// 剩下两成留给设置——历史把配额吃满之后，连保存设置都会失败。
const historyStore = createHistoryStore(storage, {
  maxSessions: 50,
  maxBytes: Math.floor(chrome.storage.local.QUOTA_BYTES * 0.8),
});

/* ========== 全局状态 ========== */
const state = {
  // 配置的规范形状见 core/settings.js：多套模型接口 + 当前使用的那套 + 全局偏好
  config: normalizeConfig(),
  // 消息历史：content 是真实请求内容（首条 user 含 <页面内容> 块），
  // displayContent 只存用户敲入的原话用于渲染（不把 12000 字页面文本刷进 UI）。
  // 工具调用轮次会追加 assistant(tool_calls)/tool/截图跟随消息，`_` 前缀字段发请求前剔除。
  messages: [],
  page: initialPage(),           // 当前页面的最新快照（形状见 core/page-sync.js）
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
  saveWarnedFor: null, // 已提示过「未能保存到历史」的 sessionId：同一段会话只提示一次
  // 上下文用量：calib 是按接口套记的校准系数（分词器是模型的属性，跨会话沿用）；
  // warned 是本段会话已提示到的档位，只在升档时提示；usage 是最近一次测量，供「+」菜单显示
  ctx: { calib: { profileId: '', ratio: 1 }, warned: 'ok', usage: null },
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
  'settings-mask', 'settings', 'btn-close-settings', 'cfg-locale',
  'cfg-profile', 'btn-profile-add', 'btn-profile-del', 'cfg-name', 'cfg-baseurl', 'cfg-model',
  'cfg-apikey', 'cfg-vision', 'cfg-context', 'cfg-mask', 'cfg-actions', 'btn-test', 'btn-save', 'test-result',
  'btn-export', 'btn-import', 'import-file',
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
  if (isSettingsOpen()) renderProfileOptions(); // 下拉里「未命名」兜底文案随语言
}

/* ========== 配置 ========== */
function isConfigured() {
  const p = activeProfile(state.config);
  return Boolean(p.baseUrl && p.model);
}

function updateConfigHint() {
  els.configHint.hidden = isConfigured();
}

async function loadConfig() {
  const saved = await storage.get('config');
  // 规整成规范形状：旧版扁平配置（顶层 baseUrl/model/apiKey/visionEnabled）在这里迁移为一套接口
  state.config = normalizeConfig(saved);
  // 未选过语言时按浏览器语言判定一次（此后不再随浏览器变化）
  if (!LOCALES.includes(state.config.locale)) {
    state.config.locale = detectLocale(navigator.languages || navigator.language);
  }
  // 迁移或补齐后的形状与存储里的不同就落盘一次，下次启动直接是规范形状
  if (JSON.stringify(state.config) !== JSON.stringify(saved)) {
    await storage.set('config', state.config);
  }
}

// 抽屉持有一份配置草稿：多套接口的增删改与下拉切换都作用于草稿，点「保存」才整体写回，
// 关闭抽屉即丢弃。与「其他字段改了不保存就作废」的既有语义一致，「保存」仍是唯一的提交点。
const drawer = { profiles: [], activeId: '' };

function resetDrawerDraft() {
  drawer.profiles = state.config.profiles.map((p) => ({ ...p }));
  drawer.activeId = state.config.activeProfileId;
}

function draftProfile() {
  return drawer.profiles.find((p) => p.id === drawer.activeId) || drawer.profiles[0];
}

// 把表单里的接口字段写回草稿中当前选中的那套（切换下拉、新增、测试、保存前都要先做）
function commitProfileForm() {
  const p = draftProfile();
  p.name = els.cfgName.value.trim();
  p.baseUrl = els.cfgBaseurl.value.trim();
  p.model = els.cfgModel.value.trim();
  p.apiKey = els.cfgApikey.value.trim();
  p.visionEnabled = els.cfgVision.checked;
  p.contextWindow = parseContextWindow(els.cfgContext.value);
}

function renderProfileOptions() {
  els.cfgProfile.innerHTML = '';
  for (const p of drawer.profiles) {
    const opt = document.createElement('option');
    opt.value = p.id;
    opt.textContent = profileLabel(p, t('ui.cfgProfileUnnamed'));
    els.cfgProfile.appendChild(opt);
  }
  els.cfgProfile.value = drawer.activeId;
}

function fillProfileForm() {
  const p = draftProfile();
  els.cfgName.value = p.name;
  els.cfgBaseurl.value = p.baseUrl;
  els.cfgModel.value = p.model;
  els.cfgApikey.value = p.apiKey;
  els.cfgVision.checked = p.visionEnabled;
  els.cfgContext.value = formatContextWindow(p.contextWindow);
  renderProfileOptions();
  els.btnProfileDel.disabled = drawer.profiles.length <= 1; // 至少保留一套
}

function readConfigForm() {
  commitProfileForm();
  return {
    profiles: drawer.profiles.map((p) => ({ ...p })),
    activeProfileId: drawer.activeId, // 下拉里选中的即为当前使用的一套
    maskEnabled: els.cfgMask.checked,
    actionsEnabled: els.cfgActions.checked,
    locale: els.cfgLocale.value, // 语言在选中时即时生效并落盘，这里只是保持整份配置完整
  };
}

function fillConfigForm() {
  resetDrawerDraft();
  els.cfgLocale.value = state.config.locale;
  els.cfgMask.checked = state.config.maskEnabled;
  els.cfgActions.checked = state.config.actionsEnabled;
  fillProfileForm();
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
  els.ctxDetailStats.textContent = page.textTotal
    ? t('ui.ctxMetaTruncated', { chars: page.textShown, total: page.textTotal, n: page.elementCount })
    : t('ui.ctxMeta', { chars: page.maskedText.length, n: page.elementCount });
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

// 对目标标签页注入 core 导出的自包含函数（snapshotPage/highlightElement/performAction），
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
// 返回值另带 loading：页面在预算内没有稳定下来（见 awaitPageReady），调用方据此在
// 消息里交代一句，免得模型把「暂无数据」当成页面的真实内容。
async function snapshotCurrentTab() {
  const active = await getActiveTab();
  if (!active) return null;
  // 用户常常是刚点开一个页面就提问，此刻文档未必加载完、数据多半还没回来。
  // 发送前的等待预算给得紧（用户在等回复）：静下来就立刻读，等不到就带着标记读。
  // 等文档 complete 的上限也收紧：挂着长轮询 iframe 的页面 status 会一直是 loading，
  // 不能让这种页每次发送都白等；文档本身是否解析完由稳定判定里的 readyState 兜住。
  const { tab, settle } = await awaitPageReady(active.id, SETTLE.send, 1500);
  if (!tab || isRestrictedUrl(tab.url)) return null;
  // 每条消息发送前都会走这里重读一次。仍是同一标签页的同一网址时按指纹继承旧编号，
  // 模型在会话中已经见过的 ref 才不会因为一次例行重读而集体作废；换了页面则干净重编。
  const inheritRefs = tab.id === state.page.tabId && tab.url === state.page.url;
  const result = await injectFunc(tab.id, snapshotPage, fullSnapshotArgs({ inheritRefs }));
  // 只有控件、没有正文的页面（纯表单、登录页）照样可读：snapshotPage 在正文与元素都为空时才返回 ok:false
  if (!result || !result.ok) return null;
  return { ...result, tabId: tab.id, loading: loadingOf(settle) };
}

// 把一次 full 快照写入 state.page（脱敏 + 命中合并，见 core/page-sync.js）
function applySnapshot(snap, tabId) {
  state.page = pageFromSnapshot(snap, { tabId, mask: state.config.maskEnabled });
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

// 刷新元素快照：老元素保号、新元素续编；session 过期或缺失（页面已导航、
// 或恢复历史会话后 page 已归零）时自动全量重建，模型据此拿到当前页面的有效编号
async function refreshedElements(tab) {
  let res = await injectFunc(tab.id, snapshotPage, {
    mode: 'elements', session: state.page.session, maxElements: MAX_ELEMENTS, i18n: injectedStrings(),
  });
  if (res && res.ok === false && res.reason === 'stale') {
    // maxTextLen 给最小值：全量重建只为拿元素映射，不需要文本通道的开销。
    // inheritRefs 让指纹相同的元素继承旧编号——SPA 重渲染后模型手里的 ref 仍然有效。
    const full = await injectFunc(tab.id, snapshotPage, {
      mode: 'full', maxTextLen: 1, maxElements: MAX_ELEMENTS, inheritRefs: true, i18n: injectedStrings(),
    });
    if (full && full.ok) {
      state.page.session = full.session;
      // session 与工作标签页是一对：只更 session 不认领 tabId 的话，page 归零后的路径
      // （恢复历史会话 + 重新生成）会一直绕过 tabId 守卫，用户中途切页也没人拦。
      if (state.page.tabId === null) state.page.tabId = tab.id;
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

// 注入 core/settle.js 的稳定判定（预算见 core/page-sync.js 的 SETTLE）；
// 注入失败（受限页、文档中途被换掉）返回 null
async function settleTab(tabId, budget) {
  const res = await injectFunc(tabId, waitForSettle, budget);
  return res && res.ok ? res : null;
}

// 等到页面就位：先等文档加载完成，再等内容稳定。稳定判定注入在导航中途会失败
// （旧文档被换掉），那就等新文档完成后再判一次；仍不成就带着「未稳定」继续——
// 等待只能让结果更准，不能卡住回合。返回的 tab 是等待之后重新取的：SPA 的 pushState
// 往往发生在等待期间，url 得以此为准。loadTimeoutMs 为 0 表示不等文档（输入类动作）。
async function awaitPageReady(tabId, budget, loadTimeoutMs) {
  let tab = await waitForTabComplete(tabId, loadTimeoutMs);
  if (!tab) return { tab: null, settle: null };
  let settle = await settleTab(tabId, budget);
  if (!settle && loadTimeoutMs > 0) {
    tab = await waitForTabComplete(tabId, loadTimeoutMs);
    if (!tab) return { tab: null, settle: null };
    settle = await settleTab(tabId, budget);
  }
  try { tab = await chrome.tabs.get(tabId); } catch { return { tab: null, settle: null }; }
  return { tab, settle };
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
  const snap = await injectFunc(tab.id, snapshotPage, fullSnapshotArgs());
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

// 记下工作页在动作期间打开的新标签页（target=_blank / window.open 的 openerTabId 指向它）。
// 动作注入前开始记、页面同步完停，只有这些标签页才算「本动作打开的」。
function watchOpenedTabs(openerId) {
  const ids = new Set();
  const onCreated = (tab) => { if (tab.openerTabId === openerId) ids.add(tab.id); };
  chrome.tabs.onCreated.addListener(onCreated);
  return { ids, stop: () => chrome.tabs.onCreated.removeListener(onCreated) };
}

// 动作执行后感知页面变化，产出给模型的变化摘要。
// mayNavigate：点击/回车这类可能触发跳转的动作要等文档加载完成；输入/选择不等文档，
// 但同样等内容稳定——联想下拉、校验提示都是输入后几百毫秒才出现的。
// budget：稳定判定的预算，wait_for_page 按模型要求的秒数传入。
// opened：本动作打开的标签页（watchOpenedTabs），只有它们会被收养为新的工作页。
async function syncAfterAction({ mayNavigate, budget = SETTLE.action, opened = new Set() }) {
  if (mayNavigate) await sleep(300); // 静默期：给导航启动留出时间，否则会读到旧页面的 complete 状态

  // 激活页换了：本动作打开的新标签页收养为工作页；用户自己切过去的不跟随。
  // 悄悄跟过去，模型会以为那一页是自己点出来的，接着在用户正在看的页面上动手。
  // 不跟随时只在结果里交代一句，同批后续调用由 tabId 守卫拦下，让模型去问用户
  let active = null;
  try { [active] = await chrome.tabs.query({ active: true, currentWindow: true }); } catch { /* 忽略 */ }
  const switched = Boolean(active && active.id && active.id !== state.page.tabId);
  const adopted = switched && opened.has(active.id);
  const userSwitched = switched && !adopted ? { title: active.title || '', url: active.url || '' } : null;
  if (adopted) state.page.tabId = active.id;

  const { tab, settle } = await awaitPageReady(state.page.tabId, budget, mayNavigate || adopted ? 8000 : 0);
  if (!tab) return { navigated: true, restricted: true, userSwitched };
  const loading = loadingOf(settle);

  if (adopted || (tab.url && tab.url !== state.page.url)) {
    return { ...(await rebuildPageAfterNavigation(tab)), loading, userSwitched };
  }

  // 未跳转：增量刷新，把新出现的元素（带 * 标记）报告给模型
  try {
    const snap = await refreshedElements(tab);
    return {
      navigated: false,
      newElements: snap.elements.filter((e) => e.isNew),
      viewport: snap.viewport,
      stats: snap.stats,
      loading,
      userSwitched,
    };
  } catch {
    return { navigated: false, newElements: [], loading, userSwitched };
  }
}

// 导航类动作的统一收尾：等文档加载完成、内容就位 → 全量重建 → 返回变化摘要
async function afterNavigation(tabId) {
  state.page.tabId = tabId;
  await sleep(400); // 让导航真正开始，否则会读到旧页面的 complete 状态
  const { tab, settle } = await awaitPageReady(tabId, SETTLE.action, 10000);
  return { ...(await rebuildPageAfterNavigation(tab)), loading: loadingOf(settle) };
}

let lastCaptureAt = 0; // 上次 captureVisibleTab 的时间戳（配额限流用）

const provider = {
  // 所有走文本通道的工具结果发给模型前统一脱敏（截图无法脱敏，见设置项说明）
  mask: (t) => (state.config.maskEnabled ? maskSensitive(t).text : t),

  async searchInPage({ query, maxResults }) {
    const tab = await requireSnapshotTab();
    // text 模式与 <页面内容> 走同一段文本通道，命中位置因此与骨架里的 @位置同一坐标系
    const res = await injectFunc(tab.id, snapshotPage, {
      mode: 'text', maxScan: BUDGETS.scan, query, maxResults, i18n: injectedStrings(),
    });
    if (!res) throw new Error(t('sys.searchFailed'));
    return res;
  },

  async readPageText({ offset, length }) {
    const tab = await requireSnapshotTab();
    // text 模式不碰 window.__titanium、不需要 session：恢复历史会话后（page 已归零）
    // 照样能读，这一点与搜索一致；也因此不在这里认领 tabId。
    const res = await injectFunc(tab.id, snapshotPage, {
      mode: 'text', maxScan: BUDGETS.scan, offset, length, i18n: injectedStrings(),
    });
    if (!res) throw new Error(t('sys.readFailed'));
    return res;
  },

  // 范围与关键词过滤在 core/tools.js，这里交出当前页全部元素
  async listElements() {
    const tab = await requireSnapshotTab();
    return await refreshedElements(tab);
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

  // 模型主动等页面加载：与动作后的同步走同一条路（等文档 → 等内容稳定 → 判定跳转 →
  // 增量刷新或全量重建），只是稳定判定的上限换成模型要的秒数。
  async waitForPage({ seconds }) {
    const tab = await requireSnapshotTab();
    // 恢复历史会话后 page 已归零（tabId 为 null），先认领当前标签页，
    // 否则下面按 state.page.tabId 取标签页会落空、被当成跳到了受限页
    if (state.page.tabId === null) state.page.tabId = tab.id;
    const started = Date.now();
    const change = await syncAfterAction({
      mayNavigate: true,
      budget: { quietMs: SETTLE.action.quietMs, maxMs: seconds * 1000 },
    });
    return { ...change, waitedMs: Date.now() - started };
  },

  /* ---------- 页内动作（注入 core/actions.js 的 performAction） ---------- */

  // 纯读取的动作不需要同步页面变化；点击与按键可能触发跳转，需等加载完成
  async act(payload) {
    const READ_ONLY = { extract_table: 1, get_html: 1 };
    const MAY_NAVIGATE = { click: 1, key: 1 };
    const tab = await requireSnapshotTab();
    // 没有 session 就没有有效的 ref 映射，也就没人担保「操作的是不是那一页」：
    // 恢复历史会话后直接「重新生成」时 state.page 已归零（tabId 也是 null，守卫形同虚设），
    // 模型重放的旧编号会落在当前页面某个陌生元素上。按 ref 的动作由 core 的 session
    // 校验拦下，不带 ref 的 scroll/press_key 只能在这里拦——让模型先 list_elements，
    // 那一步会重建映射并认领当前标签页。只读的提取类动作不受影响。
    if (!state.page.session && !READ_ONLY[payload.action]) {
      throw new Error(t('sys.noRefMapping'));
    }
    const opened = watchOpenedTabs(tab.id);
    try {
      const result = await injectFunc(tab.id, performAction, {
        ...payload, session: state.page.session, i18n: injectedStrings(),
      });
      if (!result) throw new Error(t('sys.actFailed'));
      if (READ_ONLY[payload.action] || !result.ok) return { result, change: null };
      const change = await syncAfterAction({
        mayNavigate: Boolean(MAY_NAVIGATE[payload.action]), opened: opened.ids,
      });
      return { result, change };
    } finally {
      opened.stop();
    }
  },

  /* ---------- 浏览器级动作（chrome.tabs） ---------- */

  // url 已由 core/tools.js 校验为 http/https
  async navigate({ url }) {
    const tab = await requireSnapshotTab();
    await chrome.tabs.update(tab.id, { url });
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
    const tab = await chrome.tabs.create({ url, active: true });
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
// 活动行行首的线性图标：按工具名取，24 视口、描边随字色。不用 emoji——各系统字形不一、
// 无法着色、也无法随进行中/失败态统一变色。路径全是本地常量，不依赖任何外部资源。
const TOOL_ICONS = {
  find_in_page: '<circle cx="11" cy="11" r="7"/><path d="m20 20-3.5-3.5"/>',
  read_page_text: '<path d="M2 4h6a4 4 0 0 1 4 4v12a3 3 0 0 0-3-3H2z"/><path d="M22 4h-6a4 4 0 0 0-4 4v12a3 3 0 0 1 3-3h7z"/>',
  list_elements: '<path d="M8 6h13M8 12h13M8 18h13"/><path d="M3 6h.01M3 12h.01M3 18h.01"/>',
  highlight_element: '<circle cx="12" cy="12" r="7"/><path d="M12 2v3M12 19v3M2 12h3M19 12h3"/>',
  capture_screenshot: '<path d="M3 8a2 2 0 0 1 2-2h2l2-3h6l2 3h2a2 2 0 0 1 2 2v10a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z"/><circle cx="12" cy="13" r="3.5"/>',
  extract_table: '<rect x="3" y="4" width="18" height="16" rx="2"/><path d="M3 10h18M3 15h18M10 4v16"/>',
  get_element_html: '<path d="m16 18 6-6-6-6M8 6l-6 6 6 6"/>',
  wait_for_page: '<circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/>',
  click_element: '<path d="M5 3 19 10.5 13 12.2 10.5 19z"/><path d="m13 12.2 6 6"/>',
  input_text: '<path d="M4 7V4h16v3"/><path d="M12 4v16"/><path d="M9 20h6"/>',
  select_option: '<rect x="3" y="5" width="18" height="14" rx="2"/><path d="m9 11 3 3 3-3"/>',
  press_key: '<path d="M20 4v7a4 4 0 0 1-4 4H4"/><path d="m9 10-5 5 5 5"/>',
  scroll_page: '<path d="M12 3v18"/><path d="m8 7 4-4 4 4M8 17l4 4 4-4"/>',
  navigate: '<circle cx="12" cy="12" r="9"/><path d="M3 12h18"/><ellipse cx="12" cy="12" rx="4" ry="9"/>',
  go_back: '<path d="M19 12H5"/><path d="m12 5-7 7 7 7"/>',
  refresh: '<path d="M21 12a9 9 0 1 1-9-9c2.52 0 4.93 1 6.74 2.74L21 8"/><path d="M21 3v5h-5"/>',
  open_tab: '<rect x="3" y="4" width="18" height="16" rx="2"/><path d="M3 9h18"/><path d="M7 6.5h.01"/>',
  switch_tab: '<rect x="3" y="4" width="18" height="16" rx="2"/><path d="M3 9h18"/><path d="M7 6.5h.01"/>',
  close_tab: '<rect x="3" y="4" width="18" height="16" rx="2"/><path d="M3 9h18"/><path d="M7 6.5h.01"/>',
  list_tabs: '<rect x="3" y="4" width="18" height="16" rx="2"/><path d="M3 9h18"/><path d="M7 6.5h.01"/>',
  // 未登记的工具名：三点占位
  generic: '<circle cx="12" cy="12" r="9"/><path d="M8 12h.01M12 12h.01M16 12h.01"/>',
  // 过程时间轴摘要行的折叠箭头（不是工具）：向右为折叠，CSS 旋转 90° 为展开
  chevron: '<path d="m9 6 6 6-6 6"/>',
};

function toolIcon(name) {
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  svg.setAttribute('class', 'tool-icon');
  svg.setAttribute('viewBox', '0 0 24 24');
  svg.setAttribute('fill', 'none');
  svg.setAttribute('stroke', 'currentColor');
  svg.setAttribute('stroke-width', '1.8');
  svg.setAttribute('stroke-linecap', 'round');
  svg.setAttribute('stroke-linejoin', 'round');
  svg.setAttribute('aria-hidden', 'true');
  svg.innerHTML = TOOL_ICONS[name] || TOOL_ICONS.generic; // 只写入上面的本地常量
  return svg;
}

// 有副作用的动作用 .action 样式强调——用户必须一眼看出 AI 改动了页面。
// 行 = 图标 + 文字 span；文字单独成节点，定稿时改文字不动图标。
function appendToolActivity(root, text, isAction, name) {
  const div = document.createElement('div');
  div.className = 'tool-activity running' + (isAction ? ' action' : '');
  div.appendChild(toolIcon(name));
  const span = document.createElement('span');
  span.className = 'tool-text';
  span.textContent = text;
  div.appendChild(span);
  root.appendChild(div);
  return div;
}

function settleToolActivity(div, text, ok) {
  div.classList.remove('running');
  if (!ok) div.classList.add('failed');
  div.querySelector('.tool-text').textContent = text;
}

/* ========== 过程时间轴 ========== */
// 一条 AI 回复里最终回答之前的全部过程——活动行与中途的说明段——收进 .tool-trace，
// 左侧一条浅色竖线把各步串成时间轴；回合结束后 settleTrace 配上摘要行并折叠，点击展开。
// 容器在首次出现工具调用时才建：多数回答没有工具轮次，不该平白多一层。
function traceBody(root) {
  let trace = root.querySelector(':scope > .tool-trace');
  if (!trace) {
    trace = document.createElement('div');
    trace.className = 'tool-trace';
    const head = document.createElement('button');
    head.type = 'button';
    head.className = 'trace-head';
    head.title = t('ui.traceToggle');
    head.appendChild(toolIcon('chevron'));
    const label = document.createElement('span');
    label.className = 'tool-text';
    head.appendChild(label);
    head.addEventListener('click', () => trace.classList.toggle('collapsed'));
    const body = document.createElement('div');
    body.className = 'trace-body';
    trace.append(head, body);
    root.appendChild(trace);
  }
  return trace.lastElementChild;
}

// 回合收尾：摘要行写「已执行 N 步」（含页面操作数与失败数），有结论才折叠——
// 中止或报错时若没有最终回答，过程就是全部内容，保持展开。
function settleTrace(root) {
  const trace = root.querySelector(':scope > .tool-trace');
  if (!trace) return;
  const actions = trace.querySelectorAll('.tool-activity.action').length;
  const head = trace.firstElementChild;
  head.querySelector('.tool-text').textContent = describeTrace({
    steps: trace.querySelectorAll('.tool-activity').length,
    actions,
    failed: trace.querySelectorAll('.tool-activity.failed').length,
  });
  head.classList.toggle('action', actions > 0); // 含页面操作的摘要沿用动作行的字重，折叠后仍一眼可见
  trace.classList.add('done');
  const concluded = [...root.querySelectorAll(':scope > .ai-content')].some((s) => s.textContent.trim());
  trace.classList.toggle('collapsed', concluded);
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
function finalizeAssistant(el, msgObj, contentEl, messages) {
  const target = contentEl || el.content;
  if (msgObj.content && state.page.status === 'ok') {
    // 校验对象是「页面文本 + 本会话读到的同一页正文」：只比对截断后的 12000 字的话，
    // 模型引用截断之外的真原文反而拿不到徽标（messages 用回合捕获的那份，不变式 4）
    applyQuoteBadges(target, buildQuoteCorpus(state.page.maskedText, state.page.url, messages || state.messages));
  }
  settleTrace(el.root);
  appendMessageActions(el.root, msgObj.content, true);
}

/* ========== 发送与流式 ========== */
// 「发送 / 停止」按钮：流式产文与压缩摘要都算进行中，两者共用同一个中止槽位
function updateComposer() {
  const busy = state.ui.phase !== 'idle';
  els.btnSend.textContent = t(busy ? 'ui.stop' : 'ui.send');
  els.btnSend.classList.toggle('stop', busy);
  els.chat.querySelectorAll('.ctx-warn-btn').forEach((b) => { b.disabled = busy; });
}

// 一个问答回合：流式产文 → 模型请求工具 → 执行并回填 → 再次请求。
// 轮数上限、降级、tool 链补齐这些规则都在 core/agent.js，这里只把它产出的事件画成界面，
// 并在回合收尾统一落库（正常结束 / 出错 / 用户停止都算）。
async function runAgentLoop(el) {
  state.abortController = new AbortController();
  const signal = state.abortController.signal;

  // 本回合读写的消息数组在开始时捕获一次：「新对话」在回合进行中把 state.messages
  // 换成新数组后，本回合仍在飞的回填（残句、tool 占位）落进这份已被弃用的旧数组，
  // 不会污染新会话——否则孤儿 tool 消息会让新会话的第一次请求直接 400。
  // 接口套与技能同理在开始时取定：流式中切换不影响进行中的回合，下一条消息生效。
  const messages = state.messages;
  const profile = activeProfile(state.config);

  let seg = el.content;       // 当前正文段（工具轮次间会新开段，段间夹活动行）
  let thinking = el.thinking; // 当前「思考中」指示
  let row = null;             // 正在执行的那次工具调用的活动行
  let turnError = null;       // 最终那次请求的错误（收尾时判断是否已超窗）

  // 流式重渲按帧合并：每帧最多重渲一次当前段
  let pending = '';
  let rafId = 0;
  const render = () => {
    rafId = 0;
    seg.innerHTML = renderMarkdown(pending);
    maybeScroll();
  };

  const newSegment = () => {
    seg = document.createElement('div');
    seg.className = 'ai-content';
    el.root.appendChild(seg);
    thinking = document.createElement('div');
    thinking.className = 'thinking';
    thinking.innerHTML = '<i></i><i></i><i></i>';
    el.root.appendChild(thinking);
  };

  const events = runAgentTurn({
    messages,
    provider,
    profile,
    actionsEnabled: Boolean(state.config.actionsEnabled),
    skillId: state.skillId,
    toolsBroken: state.toolsBroken,
    perceivable: () => state.page.status === 'ok',
    compact: state.compact,
    sentPage: state.sentPage,
    signal,
  });

  for await (const ev of events) {
    switch (ev.type) {
      case 'request':
        console.log('[发送内容]', ev.messages); // 验收依据：控制台可核对脱敏后的实际发送内容
        break;
      case 'delta':
        thinking.remove(); // 首字到达即撤掉「思考中」指示
        pending = ev.content;
        if (!rafId) rafId = requestAnimationFrame(render);
        break;
      case 'segment':
        if (rafId) cancelAnimationFrame(rafId);
        rafId = 0;
        thinking.remove();
        seg.innerHTML = ev.content ? renderMarkdown(ev.content) : '';
        break;
      case 'calibration':
        state.ctx.calib = { profileId: profile.id, ratio: ev.ratio };
        break;
      case 'degraded':
        if (ev.what === 'tools') state.toolsBroken = true; // 本会话此后不再带 tools
        appendNote(el.root, t(ev.what === 'tools' ? 'ui.noteToolsDegraded' : 'ui.noteImageDegraded'));
        break;
      case 'tool-round': {
        // 本段正文只是中途说明，与随后的活动行一起收进过程时间轴；空段不留
        const body = traceBody(el.root);
        if (ev.content) body.appendChild(seg); else seg.remove();
        break;
      }
      case 'tool-start':
        row = appendToolActivity(traceBody(el.root), ev.text, ev.isAction, ev.name);
        maybeScroll();
        break;
      case 'tool-done':
        settleToolActivity(row, ev.text, ev.ok);
        if (ev.image) attachShotThumbnail(row, ev.image); // 定稿会重写文字节点，缩略图要在它之后挂
        maybeScroll();
        break;
      case 'next-round':
        newSegment();
        maybeScroll();
        break;
      case 'final':
        turnError = ev.error;
        if (ev.message._error) {
          showErrorIn(el.root, ev.message._error);
        } else if (!ev.message.content && !ev.aborted) {
          seg.textContent = '';
          const note = document.createElement('p');
          note.className = 'md-note';
          note.textContent = t('ui.emptyReply');
          seg.appendChild(note);
        }
        finalizeAssistant(el, ev.message, seg, messages);
        break;
    }
  }

  state.abortController = null;
  state.ui.phase = 'idle';
  updateComposer();
  // 已经超窗报错就不必再弹一条「快满了」：错误文案里已经说了该怎么办
  if (isContextOverflow(turnError)) state.ctx.warned = 'high';
  checkContextUsage();
  maybeScroll();

  // 回合收尾自动落库：正常结束、报错、中止都算——用户消息与已产出的内容都不该丢
  await persistSession();
}

// 截图缩略图：挂在活动行文字的下方（行内），时间轴的竖线随行一起延伸；点击展开/收起大图
function attachShotThumbnail(row, src) {
  const img = document.createElement('img');
  img.className = 'tool-thumb';
  img.src = src;
  img.alt = t('ui.shotAlt');
  img.title = t('ui.shotTitle');
  img.addEventListener('click', () => img.classList.toggle('expanded'));
  row.querySelector('.tool-text').appendChild(img);
}

/* ========== 发送前的页面同步（自动完成，用户不需要点任何按钮） ========== */

// 每条消息发送前重新快照当前页面（打开侧边栏依然不读取，承诺不变），
// 再与 state.sentPage 比对决定本条消息携带什么（四种携带方式见 core/page-sync.js）。
// 快照失败的 unreadable 在这里给出：此前读过页面时 changed 为 true，交代一句免得模型拿旧页当现状。
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
  // 读取时页面仍在加载：随判定结果一起带出去，凡是携带了页面内容的消息都交代一句
  return decidePageSync(state.sentPage, state.page, Boolean(snap.loading));
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

  // 每条消息都先同步一次页面：变了才带新内容，没变什么都不带（详见 core/page-sync.js）
  const sync = await syncPageForSend();
  const { content, sentPage } = composeSendContent(inputText, state.page, state.sentPage, sync);
  state.sentPage = sentPage; // 记下「模型已经看到的页面」，下一条消息以它为基准比对

  const userMsg = {
    role: 'user',
    content,
    displayContent: inputText,
    // 携带页面块的消息打标：下次全量读取后，更早的这些会被压成一行占位
    ...(sync.kind === 'full' || sync.kind === 'diff'
      ? { _page: sync.kind, _pageTitle: state.page.title }
      : {}),
  };
  state.messages.push(userMsg);
  appendUserMessage(inputText);
  const note = describeSyncNote(sync, truncateTitle(state.page.title));
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
  if (!hasUserInput(state.messages)) {
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

  const profile = activeProfile(state.config);
  const res = await requestCompaction({
    instruction,
    messages: state.messages,
    compact: state.compact,
    profile,
    signal,
    onRequest: (requestMessages) => console.log('[发送内容]', requestMessages),
  });
  if (res.calibration) state.ctx.calib = { profileId: profile.id, ratio: res.calibration };

  state.abortController = null;
  state.ui.phase = 'idle';
  updateComposer();

  // 失败一律放弃本次压缩：原上下文原封不动，对话照常继续（中止时不报错）
  if (!res.ok) {
    note.remove();
    if (res.errorText) appendFlowError(res.errorText);
    maybeScroll();
    return;
  }

  state.compact = res.compact;
  // 压缩后旧的 <页面内容> 不再进请求：清空 sentPage，让下一条用户消息无条件重发当前页全文。
  // 不这么做的话「页面没变就什么都不带」会让模型手里只剩摘要，数字与引用会漂。
  state.sentPage = initialSentPage();
  note.textContent = t('ui.noteCompacted');
  // 压缩后重新起算：旧提醒作废，再涨上来还会提醒
  resetContextMeter();
  checkContextUsage();
  maybeScroll();
  await persistSession();
}

// 重新生成：重发上一条用户消息，替换最后一轮 AI 产物（不重新提取页面）
async function handleRegenerate() {
  if (state.ui.phase !== 'idle') return;
  if (!hasUserInput(state.messages)) return;

  // 上一轮若做过有副作用的操作，重放会在页面上再执行一遍，必须先问过用户
  if (lastTurnHasWrites(state.messages) && !window.confirm(t('ui.regenConfirm'))) {
    return;
  }

  // 整条工具链弹干净、压缩点退到被重放的用户消息之前（见 core/conversation.js）；
  // 调整后的压缩状态写回 state，由本轮收尾的 persistSession 落库
  state.compact = rewindLastTurn(state.messages, state.compact);
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
  resetContextMeter();
  state.suggest.items = [];
  state.suggest.dismissed.clear(); // 「本会话不再建议」的记忆也随会话清空
  els.chat.querySelectorAll('.msg, .flow-note, .msg-error.standalone, .ctx-warn').forEach((m) => m.remove());
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
  showSettingsResult('');
  els.settings.classList.add('open');
  els.settingsMask.classList.add('show');
}

function closeSettings() {
  els.settings.classList.remove('open');
  els.settingsMask.classList.remove('show');
}

function isSettingsOpen() {
  return els.settings.classList.contains('open');
}

// 抽屉底部的状态行：测试连接、导入导出、移除接口套共用（kind: '' | 'ok' | 'err'）
function showSettingsResult(text, kind = '') {
  els.testResult.textContent = text;
  els.testResult.className = 'test-result' + (kind ? ' ' + kind : '');
}

async function handleSaveConfig() {
  state.config = normalizeConfig(readConfigForm());
  state.toolsBroken = false; // 换了接口/模型，给 tools 一次重新探测的机会
  await storage.set('config', state.config);
  updateConfigHint();
  renderPlusMenu(); // 「页面操作」开关可能在抽屉里被改动，菜单状态同步
  closeSettings();
}

// 测试的是表单里正在编辑的那套，不要求先保存
async function handleTestConnection() {
  commitProfileForm();
  const profile = draftProfile();
  showSettingsResult(t('ui.testRunning'));
  if (!profile.baseUrl || !profile.model) {
    showSettingsResult(t('ui.testNeedFields'), 'err');
    return;
  }
  try {
    await testConnection(profile);
    showSettingsResult(t('ui.testOk'), 'ok');
  } catch (err) {
    showSettingsResult(describeError(err), 'err');
  }
}

function handleProfileSwitch() {
  commitProfileForm();
  drawer.activeId = els.cfgProfile.value;
  fillProfileForm();
}

function handleProfileAdd() {
  commitProfileForm();
  const p = emptyProfile();
  drawer.profiles.push(p);
  drawer.activeId = p.id;
  fillProfileForm();
  els.cfgName.focus();
}

// 只改草稿、不弹确认：没保存之前关掉抽屉就能反悔
function handleProfileDelete() {
  if (drawer.profiles.length <= 1) return;
  const idx = drawer.profiles.findIndex((p) => p.id === drawer.activeId);
  drawer.profiles.splice(idx, 1);
  drawer.activeId = drawer.profiles[Math.min(idx, drawer.profiles.length - 1)].id;
  fillProfileForm();
  showSettingsResult(t('ui.cfgProfileRemoved'));
}

/* ========== 设置的导出与导入（重装扩展会清空 chrome.storage.local，靠文件把配置带回来） ========== */

// 导出的是已保存的配置：抽屉里尚未保存的改动不算数，「保存」仍是唯一的提交点
function handleExportSettings() {
  const text = JSON.stringify(buildSettingsExport(state.config), null, 2);
  downloadFile('titanium-settings.json', new Blob([text], { type: 'application/json' }));
  showSettingsResult(t('ui.exportOk'), 'ok');
}

// 导入即整体覆盖并立即落盘（不经「保存」）：用户选完文件就是要它生效，再要求点一次保存只会让人疑惑。
// 页面操作开关保持用户当前的状态，文件里没有这一项（见 core/settings.js）。
async function handleImportSettings(file) {
  let parsed;
  try {
    parsed = parseSettingsImport(await file.text());
  } catch {
    showSettingsResult(t('ui.importReadFail'), 'err');
    return;
  }
  if (!parsed.ok) {
    showSettingsResult(t('ui.importBad'), 'err');
    return;
  }
  if (!window.confirm(t('ui.importConfirm'))) return;
  state.config = mergeImportedConfig(state.config, parsed.config);
  state.toolsBroken = false; // 接口换了，给 tools 一次重新探测的机会
  await storage.set('config', state.config);
  applyLocale(state.config.locale);
  fillConfigForm();
  updateConfigHint();
  showSettingsResult(t('ui.importOk', { n: state.config.profiles.length }), 'ok');
}

/* ========== 上下文用量（快满时提醒压缩） ========== */
// 回合收尾测一次「下一次请求会发出去的那条链」，升档才提醒（同一档只提醒一次），
// 压缩成功、新对话、恢复历史后重新起算。估算与校准的口径见 core/context-meter.js。
// 下一条消息若换了页还会再带一份页面全文，这里测不到——从 70% 起提醒正是给它留的余量。

function resetContextMeter() {
  state.ctx.warned = 'ok';
  state.ctx.usage = null;
  els.chat.querySelectorAll('.ctx-warn').forEach((n) => n.remove());
}

// 按下一次普通请求的形态估算（与回合里的请求同一份判定，见 core/agent.js）
function measureContext() {
  const profile = activeProfile(state.config);
  return measureNextRequest({
    messages: state.messages,
    compact: state.compact,
    profile,
    actionsEnabled: state.config.actionsEnabled,
    skillId: state.skillId,
    toolsBroken: state.toolsBroken,
    // 校准系数是分词器的属性，只对记下它的那套接口有效
    ratio: state.ctx.calib.profileId === profile.id ? state.ctx.calib.ratio : 1,
  });
}

function checkContextUsage() {
  const usage = hasUserInput(state.messages) ? measureContext() : null;
  state.ctx.usage = usage;
  if (!usage || LEVEL_RANK[usage.level] <= LEVEL_RANK[state.ctx.warned]) return;
  state.ctx.warned = usage.level;
  appendContextWarning(usage);
}

// 提醒条：只留最新一条，自带「压缩」按钮（与「+」菜单、/compact 走同一个入口）
function appendContextWarning(usage) {
  els.chat.querySelectorAll('.ctx-warn').forEach((n) => n.remove());
  const row = document.createElement('div');
  row.className = `msg-note ctx-warn${usage.level === 'high' ? ' high' : ''}`;
  const text = document.createElement('span');
  const key = usage.level !== 'high' ? 'ui.ctxWarn' : usage.pct >= 100 ? 'ui.ctxOver' : 'ui.ctxHigh';
  text.textContent = t(key, {
    pct: usage.pct, used: formatTokens(usage.used), total: formatTokens(usage.window),
  });
  const btn = document.createElement('button');
  btn.type = 'button';
  btn.className = 'ctx-warn-btn';
  btn.textContent = t('ui.ctxCompactNow');
  btn.disabled = state.ui.phase !== 'idle';
  btn.addEventListener('click', () => runCompact());
  row.append(text, btn);
  els.chat.appendChild(row);
}

/* ========== 历史会话 ========== */
// 机制总览：
//   - 保存：每个回合收尾（runAgentLoop 结束）把 messages/sentPage/skillId 整体落库；
//     没有任何用户消息不保存；标题取首条用户消息，只在首次保存时确定。
//   - 恢复：整体替换 state 里的会话数据并重建消息流 UI（replayConversation）。
//     state.page 归零——下一条消息照常重读页面并与恢复出的 sentPage 比对，
//     同页未变则什么都不带、换了页自动携带新全文，现有机制无需为历史开特例。
//   - 旧 ref 失效属预期（与 SPA 重渲染过期同一情形），模型经 list_elements 自纠。

// 当前会话落库。落库失败不打断对话——会话仍在内存里，但要在消息流里说一声：
// 用户以为已经存进历史，关掉侧边栏才发现找不回来，那就晚了。
async function persistSession() {
  if (!hasUserInput(state.messages)) return; // 没有用户消息的会话不保存
  const now = Date.now();
  if (!state.sessionId) {
    state.sessionId = newSessionId();
    state.sessionCreatedAt = now;
  }
  const record = buildSessionRecord({
    id: state.sessionId,
    createdAt: state.sessionCreatedAt,
    updatedAt: now,
    messages: state.messages,
    sentPage: state.sentPage,
    skillId: state.skillId,
    compact: state.compact,
  });
  try {
    await historyStore.save(record);
  } catch (err) {
    console.warn('[历史会话] 保存失败', err);
    if (state.saveWarnedFor !== state.sessionId) {
      state.saveWarnedFor = state.sessionId;
      appendFlowError(t(err instanceof HistoryTooLargeError ? 'ui.historySaveTooLarge' : 'ui.historySaveFailed'));
      maybeScroll();
    }
  }
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
    const turns = t(entry.turns === 1 ? 'ui.historyTurn' : 'ui.historyTurns', { n: entry.turns });
    const bits = [formatHistoryTime(entry.updatedAt), turns];
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

  els.chat.querySelectorAll('.msg, .flow-note, .msg-error.standalone, .ctx-warn').forEach((m) => m.remove());
  els.welcome.hidden = state.messages.length > 0;
  replayConversation(state.messages, state.compact);
  // 恢复的会话可能已经很长：当场测一次，快满就立刻提醒
  resetContextMeter();
  checkContextUsage();
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
  // tool_call_id → 工具名：活动行图标按工具名取，_ui 里不存图标，旧记录同样能画出来
  const toolNames = new Map();

  const closeTurn = (isLast) => {
    if (!root) return;
    if (!root.childElementCount) {
      const note = document.createElement('p');
      note.className = 'md-note';
      note.textContent = t('ui.emptyReply');
      root.appendChild(note);
    }
    if (lastSeg && lastText) applyQuoteBadges(lastSeg, buildQuoteCorpus(state.sentPage.text, state.sentPage.url, messages));
    settleTrace(root);
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
      let seg = null;
      if (m.content) {
        seg = document.createElement('div');
        seg.className = 'ai-content';
        seg.innerHTML = renderMarkdown(m.content);
        root.appendChild(seg);
        lastSeg = seg;
        lastText = m.content;
      }
      if (m._error) showErrorIn(root, m._error);
      if (m.tool_calls && m.tool_calls.length) {
        // 带工具调用的正文是中途说明，与随后的活动行一起进过程时间轴（与实时回合同一结构）
        if (seg) traceBody(root).appendChild(seg);
        for (const c of m.tool_calls) toolNames.set(c.id, c.function && c.function.name);
      }
      return;
    }
    if (m.role === 'tool' && root && m._ui) {
      const row = appendToolActivity(traceBody(root), '', m._ui.action, toolNames.get(m.tool_call_id));
      settleToolActivity(row, m._ui.text, m._ui.ok);
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
      state.suggest.dismissed.add(suggestionKey(host, id)); // 同 host + 技能，本会话不再建议
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
  state.suggest.items = tab ? suggestSkills(tab.url, state.suggest.dismissed) : [];
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
    // 测过用量后附上占比，用户不必等到提醒条出现才知道还剩多少
    hint: () => (state.ctx.usage ? t('ui.menuCompactUsage', { pct: state.ctx.usage.pct }) : t('ui.menuCompactHint')),
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
  downloadFile(`${base}.csv`, new Blob(['\uFEFF' + text], { type: 'text/csv;charset=utf-8' }));
}

// 触发浏览器下载（csv 代码块与设置导出共用）
function downloadFile(filename, blob) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
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

  // 多套接口：下拉切换 / 新增 / 删除都只动抽屉草稿；名称、地址、模型名影响下拉显示名，边敲边刷新
  els.cfgProfile.addEventListener('change', handleProfileSwitch);
  els.btnProfileAdd.addEventListener('click', handleProfileAdd);
  els.btnProfileDel.addEventListener('click', handleProfileDelete);
  for (const input of [els.cfgName, els.cfgBaseurl, els.cfgModel]) {
    input.addEventListener('input', () => {
      commitProfileForm();
      renderProfileOptions();
    });
  }

  // 导出 / 导入设置：导入走隐藏的文件选择框；选完清空 value，同一个文件再选一次也能触发 change
  els.btnExport.addEventListener('click', handleExportSettings);
  els.btnImport.addEventListener('click', () => els.importFile.click());
  els.importFile.addEventListener('change', async () => {
    const file = els.importFile.files && els.importFile.files[0];
    els.importFile.value = '';
    if (file) await handleImportSettings(file);
  });

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
