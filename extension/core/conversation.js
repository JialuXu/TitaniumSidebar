// core/conversation.js —— 消息历史的整理与请求链组装（平台无关层）
//
// 会话里的大块内容只保留最新一份（不变式 1）：页面块（全文与差异）在新全文到来后压成
// 一行占位；截图在回合收尾换成占位文本；read_page_text 读到的正文换页即作废、跨回合只留
// 最近的那些。三种压缩都只改 content、只摘 `_` 标记，绝不增删消息——tool_calls 与 tool
// 必须成对紧邻（不变式 7），而且 compact.boundary 是下标，一动数组它就漂了。
// 请求链在这之上组装：system prompt 现拼、压缩后只带「摘要 + 压缩点之后的新消息」、
// 剔除界面辅助字段。另有回合边界的判定（哪条是用户敲入的消息）与重新生成前的回退。
// 外壳只负责在正确的时机调用，消息数组由它显式传入。

import { t } from './i18n.js';
import { BUDGETS } from './format.js';
import { buildSystemPrompt, buildCompactPrompt } from './prompt.js';
import { compactRequestTail } from './compact.js';
import { WRITE_TOOL_NAMES } from './tools.js';

/* ========== 用户消息与回合边界 ========== */

/**
 * 用户敲入的消息：displayContent 只存在于这类消息上。
 * 工具上限提示、截图跟随消息同为 role:'user'，但不是用户说的话，也不算回合边界。
 */
export function isUserInput(m) {
  return Boolean(m) && m.role === 'user' && m.displayContent !== undefined;
}

/** 会话里有没有用户敲入的消息：没有就没有可保存、可压缩、可重新生成的东西 */
export function hasUserInput(messages) {
  return (messages || []).some(isUserInput);
}

/**
 * 最后一轮（最后一条用户消息之后）是否执行过有副作用的工具。
 * 重新生成会在页面上再执行一遍，外壳据此先征得用户同意。
 */
export function lastTurnHasWrites(messages) {
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i];
    if (isUserInput(m)) return false;
    if (m.tool_calls && m.tool_calls.some((c) => WRITE_TOOL_NAMES.has(c.function.name))) return true;
  }
  return false;
}

/**
 * 重新生成前回退最后一轮：从尾部弹出，直到栈顶是用户敲入的消息。工具轮次会产生
 * assistant(tool_calls)/tool/截图跟随消息，必须整条链弹干净，否则残缺的 tool 序列会让下一次请求 400。
 * 就地修改 messages，返回调整后的压缩状态（未压缩为 null）。
 *
 * 压缩点必须退到「被重放的这条用户消息」之前，否则请求链会把它一起裁掉（400）。
 * 钳到弹完后的数组长度同样不行：slice 仍会切掉栈顶那条用户消息。
 * 调用方要把返回值写回会话状态并随后续落库，只临时钳不落库会让下一次请求按旧 boundary
 * 切出残缺的 tool 链。
 */
export function rewindLastTurn(messages, compact) {
  while (messages.length && !isUserInput(messages[messages.length - 1])) messages.pop();
  if (!compact) return null;
  return { ...compact, boundary: Math.min(compact.boundary, messages.length - 1) };
}

/* ========== 页面块 ========== */

/**
 * 最新一份页面全文之前的页面块（全文与差异摘要）压成一行占位。占位里保留标题，出处仍然可追。
 * 每轮请求前都会调用：压过一次就摘掉 `_page` 标记，不重复处理。
 */
function collapseSupersededPages(messages) {
  let lastFull = -1;
  messages.forEach((m, i) => { if (m._page === 'full') lastFull = i; });
  if (lastFull <= 0) return;
  for (let i = 0; i < lastFull; i++) {
    const m = messages[i];
    if (!m._page) continue;
    m.content = `${t('sys.pageSuperseded', { title: m._pageTitle || '' })}\n\n${m.displayContent || ''}`;
    delete m._page;
  }
  // 读到的正文片段同理：位置属于旧页面，新全文一到它们就该作废
  dropSupersededReads(messages, lastFull);
}

/* ========== 读到的正文（三道闸中的跨回合那道，详见 BUDGETS 注释） ========== */

/** 把一条读取结果的 tool 消息压成占位 */
function collapseRead(msg) {
  msg.content = t('sys.readOmitted', { start: msg._read.start, end: msg._read.end });
  delete msg._read;
}

/**
 * 换页后：最新那份页面全文之前的读取结果全部作废——位置属于旧页面，留着只会误导。
 * @param {Array} messages 本回合读写的消息数组
 * @param {number} beforeIndex 最新一份全文页面块的下标
 */
function dropSupersededReads(messages, beforeIndex) {
  for (let i = 0; i < beforeIndex && i < messages.length; i++) {
    if (messages[i] && messages[i]._read) collapseRead(messages[i]);
  }
}

/**
 * 回合收尾：从新到旧累计保留的正文，超出预算的压成占位。
 * 回合内一律不淘汰（模型正拿着这些内容作答），`readRetained ≥ readMax`
 * 保证最近一次读取必然留得住，紧接着的追问不用重读。
 */
export function trimRetainedReads(messages, budget = BUDGETS.readRetained) {
  let kept = 0;
  let newest = true;
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i];
    if (!m || !m._read) continue;
    const len = (m.content || '').length;
    // 装得下才留，装不下就压占位；最近一次读取无条件保留——
    // 紧接着的追问八成就是冲它来的，回收了等于逼模型再读一遍。
    if (newest || kept + len <= budget) {
      kept += len;
      newest = false;
    } else {
      collapseRead(m);
    }
  }
}

/* ========== 截图 ========== */

/**
 * 把截图消息替换为占位文本，返回是否有替换。
 * 时机：新截图前（同一请求最多一张真图）与回合收尾（跨回合不携带旧图，控 token）。
 * 批内待回填的截图消息还没进历史，因此调用方需要连同「待回填队列」一起传进来。
 */
export function stripImagesFromHistory(...lists) {
  let changed = false;
  for (const m of lists.flat()) {
    if (m._kind === 'tool-image' && Array.isArray(m.content)) {
      m.content = m._placeholder || t('sys.shotOmitted');
      changed = true;
    }
  }
  return changed;
}

/* ========== 出网形态 ========== */

/**
 * 消息数组 → 出网形态：剔除界面辅助字段，丢掉不该进请求的空回复。
 * 必须在压缩裁剪之后调用——boundary 是原始数组的下标，先过滤会让下标漂移。
 */
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

/**
 * 普通问答一轮的请求消息。caps 与本轮请求是否带 tools 保持一致，
 * system prompt 才不会指引模型调用不存在的工具（不变式 2）。
 * @param {{ tools?: boolean, vision?: boolean, actions?: boolean, skill?: string|null }} caps
 * @param {Array<object>} messages 本回合读写的消息数组
 * @param {{ summary: string, boundary: number }|null} compact 压缩状态，null 表示未压缩
 */
export function buildRequestMessages(caps, messages, compact) {
  collapseSupersededPages(messages);
  return [
    { role: 'system', content: buildSystemPrompt(caps) },
    // 压缩过的会话只带「摘要 + 压缩点之后的新消息」；未压缩时原样带全部历史
    ...sanitizeMessages(compactRequestTail(messages, compact)),
  ];
}

/**
 * 压缩上下文那一轮的请求消息。摘要请求自身也走压缩后的请求链：已压缩过的会话
 * 只重发旧摘要 + 压缩点之后的新消息，否则等于把用户刚要求压掉的原文再发一遍，
 * 二次压缩最容易因此超窗失败。这一轮不注册 tools（不变式 2）。
 * @param {string} instruction 用户随命令给出的摘要指示，可为空
 */
export function buildCompactRequest(instruction, messages, compact) {
  collapseSupersededPages(messages);
  return [
    { role: 'system', content: buildCompactPrompt(instruction) },
    ...sanitizeMessages(compactRequestTail(messages, compact)),
  ];
}
