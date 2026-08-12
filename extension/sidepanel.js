// sidepanel.js —— 扩展外壳：UI 渲染与状态、chrome.* API 接线、把 core 模块串起来。
// 业务逻辑（提取/脱敏/组装/调用/渲染/校验）全部在 core/，本文件不实现任何业务规则。

import { extractPage } from './core/extractor.js';
import { maskSensitive } from './core/masker.js';
import { SYSTEM_PROMPT, buildUserContent } from './core/prompt.js';
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
const DEFAULT_CONFIG = { baseUrl: '', model: '', apiKey: '', maskEnabled: true };

function initialPage() {
  return {
    status: 'none',          // none 未读取 | ok 已读取 | unreadable 无法读取
    title: '',
    url: '',
    maskedText: '',          // 脱敏后的页面文本：注入 prompt 与引用校验共用同一份
    hits: null,              // 脱敏命中计数 { idCard, bankCard, phone }，未开脱敏为 null
    injected: false,         // 页面内容是否已注入过消息历史（同会话不重复注入）
    refreshRequested: false, // 用户点了「重新读取」，下一条消息重新提取
  };
}

const state = {
  config: { ...DEFAULT_CONFIG },
  // 消息历史：content 是真实请求内容（首条 user 含 <页面内容> 块），
  // displayContent 只存用户敲入的原话用于渲染（不把 12000 字页面文本刷进 UI）
  messages: [],
  page: initialPage(),
  ui: { phase: 'idle', autoScroll: true, ctxExpanded: false }, // phase: idle | streaming
  abortController: null,
  lastCitation: '', // 点击引用徽标暂存的原文（生产版可扩展为定位高亮）
};

/* ========== DOM 引用 ========== */
const els = {};
[
  'btn-new-chat', 'btn-settings', 'ctx-text', 'ctx-badge', 'btn-refresh',
  'ctx-caret', 'ctx-detail', 'ctx-detail-url', 'ctx-detail-text',
  'chat', 'welcome', 'config-hint', 'btn-goto-settings', 'input', 'btn-send',
  'settings-mask', 'settings', 'btn-close-settings', 'cfg-baseurl', 'cfg-model',
  'cfg-apikey', 'cfg-mask', 'btn-test', 'btn-save', 'test-result',
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
  };
}

function fillConfigForm() {
  els.cfgBaseurl.value = state.config.baseUrl;
  els.cfgModel.value = state.config.model;
  els.cfgApikey.value = state.config.apiKey;
  els.cfgMask.checked = state.config.maskEnabled;
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
    els.ctxText.textContent =
      `已读取：${truncateTitle(page.title)} · ${page.maskedText.length} 字${refreshSuffix}`;
    els.ctxText.title = `${page.title || ''}（点击展开/折叠已读取内容）`;
    els.ctxText.classList.add('clickable');
    els.ctxCaret.hidden = false;
    els.btnRefresh.hidden = false;
    // 详情面板内容与当前读取结果保持同步（textContent 赋值，无注入风险）
    els.ctxDetailUrl.textContent = page.url;
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

// 对当前激活标签页注入 extractPage（core 导出的自包含函数，可整体序列化）。
// 失败（受限页/注入被拒/无可读文本）统一返回 null，由调用方归一为「页面不可读」。
async function extractCurrentPage() {
  let tab;
  try {
    [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  } catch {
    return null;
  }
  if (!tab || !tab.id || isRestrictedUrl(tab.url)) return null;
  try {
    const results = await chrome.scripting.executeScript({
      target: { tabId: tab.id },
      func: extractPage,
    });
    const result = results && results[0] && results[0].result;
    if (!result || !result.ok || !result.text) return null;
    return result;
  } catch {
    return null;
  }
}

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

// 流结束后的收尾：引用块出处校验 + 操作行。
// 徽标必须在流结束后一次性插入——流式过程中每帧全量重渲会把它抹掉。
function finalizeAssistant(el, msgObj) {
  if (msgObj.content && state.page.status === 'ok') {
    el.content.querySelectorAll('blockquote').forEach((bq) => {
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
function buildRequestMessages() {
  return [
    { role: 'system', content: SYSTEM_PROMPT },
    ...state.messages
      .filter((m) => m.role !== 'assistant' || m.content) // 失败的空回复不进入请求
      .map(({ role, content }) => ({ role, content })),
  ];
}

function updateComposer() {
  const streaming = state.ui.phase === 'streaming';
  els.btnSend.textContent = streaming ? '停止' : '发送';
  els.btnSend.classList.toggle('stop', streaming);
}

async function runStream(requestMessages, msgObj, el) {
  state.abortController = new AbortController();
  let acc = '';
  let rafId = 0;
  const scheduleRender = () => {
    if (rafId) return;
    rafId = requestAnimationFrame(() => {
      rafId = 0;
      el.content.innerHTML = renderMarkdown(acc);
      maybeScroll();
    });
  };

  let streamError = null;
  try {
    for await (const delta of streamChat(state.config, requestMessages, state.abortController.signal)) {
      if (!acc) el.thinking.remove(); // 首字到达即撤掉“思考中”指示
      acc += delta;
      scheduleRender();
    }
  } catch (err) {
    streamError = err;
  }

  // 收尾（正常结束 / 出错 / 用户停止都会走到这里）
  if (rafId) cancelAnimationFrame(rafId);
  el.thinking.remove();
  msgObj.content = acc;
  el.content.innerHTML = acc ? renderMarkdown(acc) : '';

  const aborted = streamError instanceof LlmError && streamError.kind === 'abort';
  if (streamError && !aborted) {
    showErrorIn(el.root, describeError(streamError)); // 中止不算错误，保留已生成部分
  } else if (!acc && !streamError) {
    el.content.innerHTML = '<p class="md-note">（模型未返回内容）</p>';
  }
  finalizeAssistant(el, msgObj);

  state.abortController = null;
  state.ui.phase = 'idle';
  updateComposer();
  maybeScroll();
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

  // 首条消息或用户点了「重新读取」时才执行页面提取
  let contentForRequest;
  if (!state.page.injected || state.page.refreshRequested) {
    updateContextBar('reading');
    const extracted = await extractCurrentPage();
    if (extracted) {
      const maskRes = state.config.maskEnabled
        ? maskSensitive(extracted.text)
        : { text: extracted.text, hits: null };
      state.page = {
        status: 'ok',
        title: extracted.title,
        url: extracted.url,
        maskedText: maskRes.text,
        hits: maskRes.hits,
        injected: true,
        refreshRequested: false,
      };
      contentForRequest = buildUserContent(inputText, state.page.maskedText);
    } else {
      // 提取失败也置 injected，避免同会话每条消息都无谓重试；可用「重新读取」手动再试
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

  const requestMessages = buildRequestMessages();
  console.log('[发送内容]', requestMessages); // 验收依据：控制台可核对脱敏后的实际发送内容

  const msgObj = { role: 'assistant', content: '' };
  state.messages.push(msgObj);
  const el = appendAssistantMessage();
  maybeScroll();

  await runStream(requestMessages, msgObj, el);
}

// 重新生成：重发上一条用户消息，替换最后一条 AI 回复（不重新提取页面）
async function handleRegenerate() {
  if (state.ui.phase !== 'idle') return;
  const last = state.messages[state.messages.length - 1];
  if (!last || last.role !== 'assistant') return;

  state.messages.pop();
  const aiNodes = els.chat.querySelectorAll('.msg-ai');
  if (aiNodes.length) aiNodes[aiNodes.length - 1].remove();

  state.ui.phase = 'streaming';
  updateComposer();
  state.ui.autoScroll = true;

  const requestMessages = buildRequestMessages();
  console.log('[发送内容]', requestMessages);

  const msgObj = { role: 'assistant', content: '' };
  state.messages.push(msgObj);
  const el = appendAssistantMessage();
  maybeScroll();

  await runStream(requestMessages, msgObj, el);
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
