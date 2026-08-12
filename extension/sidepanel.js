// sidepanel.js —— 扩展外壳：UI 渲染与状态、chrome.* API 接线、把 core 模块串起来。
// 业务逻辑（提取/脱敏/组装/调用/渲染/校验）全部在 core/，本文件不实现任何业务规则。

import { snapshotPage } from './core/snapshot.js';
import { searchPage } from './core/search.js';
import { highlightElement } from './core/highlight.js';
import { buildToolDefs, dispatchToolCall, MAX_TOOL_ROUNDS } from './core/tools.js';
import { annotateScreenshot } from './core/annotate.js';
import { formatOutline } from './core/format.js';
import { maskSensitive } from './core/masker.js';
import { buildSystemPrompt, buildUserContent } from './core/prompt.js';
import { streamChat, testConnection, LlmError } from './core/llm-client.js';
import { renderMarkdown } from './core/markdown.js';
import { verifyQuote } from './core/citation.js';

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
const DEFAULT_CONFIG = { baseUrl: '', model: '', apiKey: '', maskEnabled: true, visionEnabled: false };

function initialPage() {
  return {
    status: 'none',          // none 未读取 | ok 已读取 | unreadable 无法读取
    title: '',
    url: '',
    maskedText: '',          // 脱敏后的页面文本：注入 prompt 与引用校验共用同一份
    outlineText: '',         // 脱敏后的结构骨架文本（注入 prompt + 详情面板展示）
    elementCount: 0,         // 快照时的可交互元素数（状态条展示）
    session: '',             // ref 映射的会话标识，页面侧 window.__titanium 持有同名值
    tabId: null,             // 快照来源标签页，工具调用前校验是否仍是当前激活页
    hits: null,              // 脱敏命中计数 { idCard, bankCard, phone }，未开脱敏为 null
    injected: false,         // 页面内容是否已注入过消息历史（同会话不重复注入）
    refreshRequested: false, // 用户点了「重新读取」，下一条消息重新提取
  };
}

const state = {
  config: { ...DEFAULT_CONFIG },
  // 消息历史：content 是真实请求内容（首条 user 含 <页面内容> 块），
  // displayContent 只存用户敲入的原话用于渲染（不把 12000 字页面文本刷进 UI）。
  // 工具调用轮次会追加 assistant(tool_calls)/tool/截图跟随消息，`_` 前缀字段发请求前剔除。
  messages: [],
  page: initialPage(),
  ui: { phase: 'idle', autoScroll: true, ctxExpanded: false }, // phase: idle | streaming
  abortController: null,
  toolsBroken: false, // 接口不支持 tools（收到过 400/422），本会话降级纯文本；保存配置时重置
  lastCitation: '', // 点击引用徽标暂存的原文（生产版可扩展为定位高亮）
};

/* ========== DOM 引用 ========== */
const els = {};
[
  'btn-new-chat', 'btn-settings', 'ctx-text', 'ctx-badge', 'btn-refresh',
  'ctx-caret', 'ctx-detail', 'ctx-detail-url', 'ctx-detail-outline', 'ctx-detail-text',
  'chat', 'welcome', 'config-hint', 'btn-goto-settings', 'input', 'btn-send',
  'settings-mask', 'settings', 'btn-close-settings', 'cfg-baseurl', 'cfg-model',
  'cfg-apikey', 'cfg-mask', 'cfg-vision', 'btn-test', 'btn-save', 'test-result',
].forEach((id) => {
  els[id.replace(/-([a-z])/g, (_, c) => c.toUpperCase())] = document.getElementById(id);
});

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
}

function readConfigForm() {
  return {
    baseUrl: els.cfgBaseurl.value.trim(),
    model: els.cfgModel.value.trim(),
    apiKey: els.cfgApikey.value.trim(),
    maskEnabled: els.cfgMask.checked,
    visionEnabled: els.cfgVision.checked,
  };
}

function fillConfigForm() {
  els.cfgBaseurl.value = state.config.baseUrl;
  els.cfgModel.value = state.config.model;
  els.cfgApikey.value = state.config.apiKey;
  els.cfgMask.checked = state.config.maskEnabled;
  els.cfgVision.checked = state.config.visionEnabled;
}

/* ========== 错误文案映射（外壳职责，core 只抛结构化错误） ========== */
function describeError(err) {
  if (err instanceof LlmError) {
    switch (err.kind) {
      case 'badconfig':
        return '尚未配置模型接口：请在设置中填写接口地址与模型名称。';
      case 'network':
        return '网络请求失败：请检查网络连接，以及接口地址是否可达。';
      case 'stream':
        return '响应流中断：回复可能不完整，请重试。';
      case 'http': {
        if (err.status === 401) return '鉴权失败（401）：请检查 API Key 是否正确。';
        if (err.status === 403) return '无权限（403）：请检查 API Key 权限或网关配置。';
        if (err.status === 404) return '接口不存在（404）：请检查接口地址是否完整（通常需要以 /v1 结尾）。';
        if (err.status === 429) return '请求过于频繁（429）：请稍后重试。';
        if (err.status >= 500) return `服务端错误（${err.status}）：模型服务暂不可用，请稍后重试。`;
        const detail = (err.detail || '').slice(0, 200);
        return `请求失败（HTTP ${err.status}）${detail ? '：' + detail : ''}`;
      }
    }
  }
  return '发生未知错误：' + ((err && err.message) || String(err));
}

/* ========== 上下文状态条 ========== */
function truncateTitle(title, max = 22) {
  if (!title) return '未命名页面';
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
  els.ctxBadge.hidden = true;
  els.btnRefresh.hidden = true;
  els.ctxCaret.hidden = true;
  els.ctxText.classList.remove('clickable');

  if (transient === 'reading') {
    els.ctxText.textContent = '正在读取页面…';
    setCtxExpanded(false);
    return;
  }

  const refreshSuffix = page.refreshRequested ? ' · 下一条消息将重新读取' : '';

  if (page.status === 'ok') {
    const elemPart = page.elementCount ? ` · ${page.elementCount} 个交互元素` : '';
    els.ctxText.textContent =
      `已读取：${truncateTitle(page.title)} · ${page.maskedText.length} 字${elemPart}${refreshSuffix}`;
    els.ctxText.title = `${page.title || ''}（点击展开/折叠已读取内容）`;
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
      els.ctxBadge.textContent = `脱敏 ${total}`;
      els.ctxBadge.title = `身份证 ${hits.idCard} · 银行卡 ${hits.bankCard} · 手机号 ${hits.phone}`;
      els.ctxBadge.hidden = false;
    }
  } else if (page.status === 'unreadable') {
    els.ctxText.textContent = `当前页面无法读取，将仅基于问题本身回答${refreshSuffix}`;
    els.ctxText.title = '';
    els.btnRefresh.hidden = false;
    setCtxExpanded(false);
  } else {
    els.ctxText.textContent = '发送消息时将读取当前页面';
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
    mode: 'full', maxTextLen: 12000, maxElements: 300,
  });
  if (!result || !result.ok || !result.text) return null;
  return { ...result, tabId: tab.id };
}

/* ========== 感知工具 provider（chrome.* 接线，执行由 core/tools.js 调度） ========== */

// 工具执行前置校验：当前激活标签页必须仍是快照来源页（截图截的就是激活页，必须守卫）
async function requireSnapshotTab() {
  const tab = await getActiveTab();
  if (!tab) throw new Error('当前页面无法读取（浏览器内部页或受限页面）。');
  if (state.page.tabId !== null && tab.id !== state.page.tabId) {
    throw new Error('当前激活的标签页已切换，与已读取的页面不一致；请让用户点击「重新读取」后再提问。');
  }
  return tab;
}

// 刷新元素快照：老元素保号、新元素续编；session 过期（页面已导航）时自动全量重建
async function refreshedElements(tab) {
  let res = await injectFunc(tab.id, snapshotPage, {
    mode: 'elements', session: state.page.session, maxElements: 300,
  });
  if (res && res.ok === false && res.reason === 'stale') {
    // maxTextLen 给最小值：全量重建只为拿元素映射，不需要文本通道的开销
    const full = await injectFunc(tab.id, snapshotPage, { mode: 'full', maxTextLen: 1, maxElements: 300 });
    if (full && full.ok) {
      state.page.session = full.session;
      res = { ok: true, elements: full.elements, viewport: full.viewport };
    }
  }
  if (!res || !res.ok) throw new Error('无法读取页面元素（页面可能已刷新或受限）。');
  return res;
}

let lastCaptureAt = 0; // 上次 captureVisibleTab 的时间戳（配额限流用）

const provider = {
  // 所有走文本通道的工具结果发给模型前统一脱敏（截图无法脱敏，见设置项说明）
  mask: (t) => (state.config.maskEnabled ? maskSensitive(t).text : t),

  async searchInPage({ query, maxResults }) {
    const tab = await requireSnapshotTab();
    const res = await injectFunc(tab.id, searchPage, { query, maxResults });
    if (!res) throw new Error('无法在当前页面中执行搜索（页面可能已刷新或受限）。');
    return res;
  },

  async listElements({ scope, query }) {
    const tab = await requireSnapshotTab();
    const snap = await refreshedElements(tab);
    let elements = snap.elements;
    if (scope === 'viewport') elements = elements.filter((e) => e.inViewport);
    if (query) {
      const q = query.toLowerCase();
      elements = elements.filter((e) => (e.name || '').toLowerCase().includes(q));
    }
    return { elements, total: elements.length };
  },

  async highlight({ ref }) {
    const tab = await requireSnapshotTab();
    const res = await injectFunc(tab.id, highlightElement, {
      ref, session: state.page.session, durationMs: 3000,
    });
    if (!res) throw new Error('无法在当前页面上执行高亮（页面可能已刷新或受限）。');
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
      throw new Error('截图失败：' + ((err && err.message) || '浏览器拒绝了截图请求（窗口需处于可见状态）。'));
    }
    lastCaptureAt = Date.now();
    const marks = snap.elements
      .filter((e) => e.inViewport)
      .map(({ ref, bbox }) => ({ ref, bbox }));
    const { dataUrl, markCount } = await annotateScreenshot(raw, marks, snap.viewport);
    return { dataUrl, markCount, viewport: snap.viewport };
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
function appendToolActivity(root, text) {
  const div = document.createElement('div');
  div.className = 'tool-activity running';
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
  switch (name) {
    case 'find_in_page':
      if (phase === 'run') return `🔍 正在页面中搜索「${a.query || ''}」…`;
      if (phase === 'fail') return `🔍 搜索「${a.query || ''}」失败`;
      return data.total
        ? `🔍 已搜索「${data.query}」：${data.total} 处匹配`
        : `🔍 已搜索「${data.query}」：无匹配`;
    case 'list_elements':
      if (phase === 'run') return '🧭 正在读取可交互元素…';
      if (phase === 'fail') return '🧭 读取可交互元素失败';
      return `🧭 已读取可交互元素：${data.count} 个${data.scope === 'viewport' ? '（可见区域）' : ''}`;
    case 'highlight_element':
      if (phase === 'run') return `📍 正在页面上高亮元素 [${a.ref ?? '?'}]…`;
      if (phase === 'fail') return `📍 高亮元素 [${a.ref ?? '?'}] 失败`;
      return `📍 已高亮元素 [${data.ref}]${data.name ? ` "${data.name}"` : ''}`;
    case 'capture_screenshot':
      if (phase === 'run') return '📷 正在截取当前视口…';
      if (phase === 'fail') return '📷 截图失败';
      return `📷 已截取当前视口（标注 ${data.markCount} 个元素）`;
    default:
      return phase === 'run' ? `⚙️ 正在调用 ${name}…` : `⚙️ ${name} ${phase === 'fail' ? '失败' : '完成'}`;
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
      badge.textContent = '来自当前页面';
      badge.title = '点击暂存该原文';
      badge.addEventListener('click', () => {
        state.lastCitation = quoteText;
        badge.textContent = '已暂存';
        setTimeout(() => { badge.textContent = '来自当前页面'; }, 1200);
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
    copyBtn.textContent = '复制全文';
    copyBtn.addEventListener('click', async () => {
      await navigator.clipboard.writeText(msgObj.content).catch(() => {});
      copyBtn.textContent = '已复制';
      setTimeout(() => { copyBtn.textContent = '复制全文'; }, 1200);
    });
    actions.appendChild(copyBtn);
  }
  const regenBtn = document.createElement('button');
  regenBtn.type = 'button';
  regenBtn.className = 'btn-regen';
  regenBtn.textContent = '重新生成';
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
  els.btnSend.textContent = streaming ? '停止' : '发送';
  els.btnSend.classList.toggle('stop', streaming);
}

// 把历史中的截图消息替换为占位文本，返回是否有替换。
// 时机：新截图前（同一请求最多一张真图）与回合收尾（跨回合不携带旧图，控 token）。
function stripImagesFromHistory() {
  let changed = false;
  for (const m of state.messages) {
    if (m._kind === 'tool-image' && Array.isArray(m.content)) {
      m.content = m._placeholder || '[视口截图已省略]';
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
    const useTools = !state.toolsBroken && state.page.status === 'ok' && rounds < MAX_TOOL_ROUNDS;
    const vision = useTools && Boolean(state.config.visionEnabled);
    const tools = useTools ? buildToolDefs({ vision }) : undefined;
    const requestMessages = buildRequestMessages({ tools: useTools, vision });
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
        appendNote(el.root, '当前接口不支持工具调用，已降级为纯文本模式（仍会注入页面文本与结构骨架）。');
        continue; // 不带 tools 原样重试本轮
      }
      if (!imagesRetried && stripImagesFromHistory()) {
        imagesRetried = true;
        appendNote(el.root, '当前接口不支持图片输入，已移除截图重试；建议在设置中关闭「模型支持视觉」。');
        continue;
      }
    }

    // 没有工具调用（正常结束/出错/中止）：本段即最终回复。
    // rounds 硬上限兜底：即使请求不带 tools，病态网关仍返回 tool_calls 也不再执行
    if (streamError || !calls || !calls.length || rounds >= MAX_TOOL_ROUNDS + 2) {
      const msgObj = { role: 'assistant', content: acc };
      state.messages.push(msgObj);
      const aborted = streamError instanceof LlmError && streamError.kind === 'abort';
      if (streamError && !aborted) {
        showErrorIn(el.root, describeError(streamError)); // 中止不算错误，保留已生成部分
      } else if (!acc && !streamError) {
        seg.innerHTML = '<p class="md-note">（模型未返回内容）</p>';
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

    for (const call of calls) {
      // 中止：未执行的调用补占位 tool 消息——tool_calls 必须一一回填，否则历史不合法（下轮 400）
      if (signal.aborted) {
        state.messages.push({ role: 'tool', tool_call_id: call.id, content: '（用户已中止，未执行）' });
        continue;
      }
      let argsForUi = null;
      try { argsForUi = call.arguments ? JSON.parse(call.arguments) : {}; } catch { /* 文案按 null 兜底 */ }
      const row = appendToolActivity(el.root, describeToolActivity(call.name, argsForUi, 'run'));
      maybeScroll();
      if (call.name === 'capture_screenshot') stripImagesFromHistory(); // 同一请求最多一张真图
      const { toolMessage, followUpMessage, meta } = await dispatchToolCall(call, provider);
      state.messages.push(toolMessage);
      if (followUpMessage) {
        followUpMessage._placeholder =
          `[视口截图已省略：${meta.data.w}×${meta.data.h}，标注 ${meta.data.markCount} 个元素]`;
        state.messages.push(followUpMessage);
        attachShotThumbnail(row, followUpMessage);
      }
      settleToolActivity(
        row,
        describeToolActivity(call.name, meta.args || argsForUi, meta.ok ? 'done' : 'fail', meta.data),
        meta.ok
      );
      maybeScroll();
    }

    if (signal.aborted) {
      // 中止在工具阶段发生：没有最终回复文本，只挂操作行便于「重新生成」
      finalizeAssistant(el, { role: 'assistant', content: '' }, seg);
      break;
    }

    rounds++;
    if (rounds === MAX_TOOL_ROUNDS) {
      // 达到上限：下一轮 useTools 为 false（请求不带 tools），并明确告知模型直接作答
      state.messages.push({
        role: 'user',
        content: '（系统提示）工具调用次数已达上限，请直接基于已有信息作答。',
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
  img.alt = '视口截图';
  img.title = '点击放大/还原';
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
      // 文本与结构骨架都走文本通道，发给模型前必须一并脱敏；命中数合并计入徽标
      const outlineRaw = formatOutline(snap.outline);
      const maskOn = state.config.maskEnabled;
      const textRes = maskOn ? maskSensitive(snap.text) : { text: snap.text, hits: null };
      const outlineRes = maskOn ? maskSensitive(outlineRaw) : { text: outlineRaw, hits: null };
      const hits = textRes.hits
        ? {
            idCard: textRes.hits.idCard + outlineRes.hits.idCard,
            bankCard: textRes.hits.bankCard + outlineRes.hits.bankCard,
            phone: textRes.hits.phone + outlineRes.hits.phone,
          }
        : null;
      state.page = {
        status: 'ok',
        title: snap.title,
        url: snap.url,
        maskedText: textRes.text,
        outlineText: outlineRes.text,
        elementCount: snap.stats.totalElements,
        session: snap.session,
        tabId: snap.tabId,
        hits,
        injected: true,
        refreshRequested: false,
      };
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
  closeSettings();
}

async function handleTestConnection() {
  const config = readConfigForm();
  els.testResult.textContent = '正在测试…';
  els.testResult.className = 'test-result';
  if (!config.baseUrl || !config.model) {
    els.testResult.textContent = '请先填写接口地址与模型名称。';
    els.testResult.className = 'test-result err';
    return;
  }
  try {
    await testConnection(config);
    els.testResult.textContent = '连接成功，接口可用。';
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

/* ========== 事件绑定 ========== */
function bindEvents() {
  els.btnSend.addEventListener('click', () => {
    if (state.ui.phase === 'streaming') handleStop();
    else handleSend();
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
    btn.textContent = '已复制';
    setTimeout(() => { btn.textContent = '复制'; }, 1200);
  });
}

/* ========== 启动（只读配置，不读页面、不发网络请求） ========== */
(async function init() {
  await loadConfig();
  updateConfigHint();
  updateContextBar();
  bindEvents();
})();
