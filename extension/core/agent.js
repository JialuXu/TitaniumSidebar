// core/agent.js —— 回合编排：流式产文 → 模型请求工具 → 执行并回填 → 再次请求（平台无关层）
//
// 外壳只做三件事：回合开始时交出本回合读写的消息数组（不变式 4）、注入执行工具的 provider、
// 把 runAgentTurn 产出的事件画成界面。这一轮带不带 tools、400 之后怎么降级、tool 链怎么补齐、
// 截图消息何时进历史，这些规则都在这里，SDK 外壳原样复用。
// 压缩上下文那一轮（requestCompaction）与回合共用接口与错误文案，也放在这里。

import { t } from './i18n.js';
import { streamChat, LlmError, isContextOverflow } from './llm-client.js';
import {
  buildToolDefs, dispatchToolCall, MAX_TOOL_ROUNDS, MAX_ACTION_ROUNDS, WRITE_TOOL_NAMES,
} from './tools.js';
import { describeToolActivity } from './activity.js';
import {
  buildRequestMessages, buildCompactRequest, stripImagesFromHistory, trimRetainedReads,
} from './conversation.js';
import { buildCompactState } from './compact.js';
import { estimateTokens, calibrationRatio, contextUsage } from './context-meter.js';

/* ========== 错误文案 ========== */

/**
 * LlmError → 带排查建议的可读文案。llm-client 只抛结构化错误，文案在这里取词，
 * 回合报错、压缩失败与「测试连接」共用。
 */
export function describeError(err) {
  if (isContextOverflow(err)) return t('err.contextOverflow');
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

const isAbort = (err) => err instanceof LlmError && err.kind === 'abort';

/* ========== 请求形态 ========== */

/**
 * 一次普通请求的形态：带不带 tools、注册哪几组、system prompt 按什么能力拼（不变式 2）。
 * 回合里的每轮请求与上下文用量估算共用这一份判定，两处才不会悄悄分叉。
 * @param {object} o
 * @param {object} o.profile 当前接口套（视觉是模型属性，随套保存）
 * @param {boolean} o.actionsEnabled 「允许页面操作」开关
 * @param {string|null} o.skillId 会话级技能
 * @param {boolean} o.toolsBroken 接口不支持 tools，本会话已降级纯文本
 * @param {boolean} o.perceivable 工作页可读。读不到时感知工具无用武之地，但动作工具仍有意义——
 *   用户在 chrome:// 新标签页上说「打开某网址并总结」，靠的就是 open_tab
 * @param {boolean} [o.withinRounds] 工具轮数还没到上限
 * @returns {{ caps: object, tools: Array<object>|undefined, registered: Set<string> }}
 */
export function requestShape({ profile, actionsEnabled, skillId, toolsBroken, perceivable, withinRounds = true }) {
  const useTools = !toolsBroken && (perceivable || Boolean(actionsEnabled)) && withinRounds;
  const vision = useTools && Boolean(profile && profile.visionEnabled);
  const actions = useTools && Boolean(actionsEnabled);
  const tools = useTools ? buildToolDefs({ vision, actions }) : undefined;
  return {
    caps: { tools: useTools, vision, actions, skill: skillId || null },
    tools,
    // 本次请求实际注册的工具名：执行前逐个对照，开关与轮数上限才真正管得住（见 dispatchToolCall）
    registered: new Set((tools || []).map((d) => d.function.name)),
  };
}

/**
 * 估算「下一次普通请求」的上下文用量。形态与回合里的请求一致，只是不看页面是否可读——
 * 多估一份工具定义，宁可早提醒。下一条消息若换了页还会再带一份页面全文，这里测不到，
 * 从 70% 起提醒正是给它留的余量。
 * @param {object} o requestShape 的入参（不含 perceivable）+ messages / compact / ratio
 * @param {number} [o.ratio] 该接口套的校准系数，缺省 1
 */
export function measureNextRequest({ messages, compact, profile, actionsEnabled, skillId, toolsBroken, ratio = 1 }) {
  const { caps, tools } = requestShape({ profile, actionsEnabled, skillId, toolsBroken, perceivable: true });
  const chain = buildRequestMessages(caps, messages, compact);
  return contextUsage(estimateTokens(chain, tools), { ratio, window: profile.contextWindow });
}

// 接口在流里报了真实用量：与同一请求的估算值比出校准系数（数据不可用时为 null）
function calibrationOf(usage, requestMessages, tools) {
  return usage ? calibrationRatio(usage.promptTokens, estimateTokens(requestMessages, tools)) : null;
}

// 截图跟随消息里的图片地址（活动行缩略图用）
function imageOf(followUpMessage) {
  const part = Array.isArray(followUpMessage.content) &&
    followUpMessage.content.find((p) => p.type === 'image_url');
  return part ? part.image_url.url : '';
}

/* ========== 回合 ========== */

/**
 * 一个问答回合（异步生成器），最多 MAX_TOOL_ROUNDS / MAX_ACTION_ROUNDS 轮工具调用。
 * 消息数组就地读写：用户消息由外壳在调用前追加好，回合里的 assistant / tool / 截图跟随消息
 * 都落进同一个数组；回合结束时历史里的截图换成占位、读到的正文收口（不变式 1）。
 * 接口套、页面操作开关与技能在回合开始时取定，流式中改动只影响下一条消息。
 *
 * @param {object} o
 * @param {Array<object>} o.messages 本回合读写的消息数组，外壳在回合开始时捕获（不变式 4）
 * @param {object} o.provider 执行工具的 provider（见 core/tools.js）
 * @param {object} o.profile 接口套
 * @param {boolean} o.actionsEnabled
 * @param {string|null} o.skillId
 * @param {boolean} o.toolsBroken 初值；本回合降级后以 degraded 事件告知外壳
 * @param {() => boolean} o.perceivable 工作页当前是否可读。每轮请求前现问：回合里的动作可能把工作页换成读不到的页面
 * @param {{ summary: string, boundary: number }|null} o.compact 压缩状态
 * @param {{ url: string, textTotal?: number }} o.sentPage 模型手里那份页面（不变式 6）
 * @param {AbortSignal} [o.signal]
 *
 * 产出事件：
 *   { type: 'request', messages, tools }            每次请求发出前（出网形态，外壳可打印核对）
 *   { type: 'delta', content }                      正文增量，content 为本段累计全文
 *   { type: 'segment', content }                    本段的流结束了（正常、出错或中止）
 *   { type: 'calibration', ratio }                  接口报了用量，得出新的校准系数
 *   { type: 'degraded', what: 'tools'|'images' }    400/422 后去掉 tools 或图片，重试本轮
 *   { type: 'tool-round', content }                 本段以工具调用结束：它是中途说明，不是最终回答
 *   { type: 'tool-start', name, isAction, text }    一次工具调用开始
 *   { type: 'tool-done', name, isAction, ok, text, image }  调用结束，text 为定稿文案，image 为截图地址
 *   { type: 'next-round' }                          工具结果已回填，开始下一轮请求
 *   { type: 'final', message, error, aborted }      回合结束。message 为最终回复，报错文案已写在
 *                                                   message._error；中止在工具阶段时它是不入历史的空回复
 */
export async function* runAgentTurn({
  messages, provider, profile, actionsEnabled, skillId, toolsBroken, perceivable, compact, sentPage, signal,
}) {
  // 开了页面操作的回合允许更多轮：一次表单填写光是「列元素 + 逐个输入 + 提交 + 验证」
  // 就要八九轮，5 轮必然半途而废
  const roundLimit = actionsEnabled ? MAX_ACTION_ROUNDS : MAX_TOOL_ROUNDS;
  // 本回合的读取账本 + 「模型手里那份页面」的基准。基准取 sentPage 而不是当前页面：
  // 位置是否还作数，要看模型上次实际看到的是哪一页、多长（不变式 6）
  const turn = { readChars: 0, url: sentPage.url, textTotal: sentPage.textTotal || 0 };
  const aborted = () => Boolean(signal && signal.aborted);
  let rounds = 0;             // 已完成的工具轮数
  let broken = Boolean(toolsBroken);
  let imagesRetried = false;  // 「接口不支持图片」降级只重试一次

  try {
    while (true) {
      const { caps, tools, registered } = requestShape({
        profile, actionsEnabled, skillId, toolsBroken: broken,
        perceivable: perceivable(), withinRounds: rounds < roundLimit,
      });
      const requestMessages = buildRequestMessages(caps, messages, compact);
      yield { type: 'request', messages: requestMessages, tools };

      let acc = '';
      let calls = null;
      let usage = null;
      let streamError = null;
      try {
        for await (const ev of streamChat(profile, requestMessages, { signal, tools })) {
          if (ev.type === 'delta') {
            acc += ev.text;
            yield { type: 'delta', content: acc };
          } else if (ev.type === 'tool_calls') {
            calls = ev.calls;
          } else if (ev.type === 'usage') {
            usage = ev;
          }
        }
      } catch (err) {
        streamError = err;
      }
      const ratio = calibrationOf(usage, requestMessages, tools);
      if (ratio) yield { type: 'calibration', ratio };
      yield { type: 'segment', content: acc };

      // 降级路径：400/422 视为「接口不认识请求里的新字段」，先怀疑 tools，再怀疑图片。
      // 各只降一次，5xx/网络错误不吞，照常报错。超窗不是「不认识新字段」，
      // 去掉 tools 重试只会把本会话永久降级
      if (
        streamError instanceof LlmError && streamError.kind === 'http' &&
        (streamError.status === 400 || streamError.status === 422) && !aborted() &&
        !isContextOverflow(streamError)
      ) {
        if (tools) {
          broken = true;
          yield { type: 'degraded', what: 'tools' };
          continue; // 不带 tools 原样重试本轮
        }
        if (!imagesRetried && stripImagesFromHistory(messages)) {
          imagesRetried = true;
          yield { type: 'degraded', what: 'images' };
          continue;
        }
      }

      // 没有工具调用（正常结束/出错/中止）：本段即最终回复。
      // 本次请求没带 tools（到了轮数上限、已降级纯文本、页面不可读且没开动作）时，
      // 网关仍返回的 tool_calls 整批丢弃：不落历史就不必补占位，也不会再请求一轮
      if (streamError || !calls || !calls.length || !tools) {
        const message = { role: 'assistant', content: acc };
        // 中止不算错误，保留已生成部分；错误文案落在消息上，历史回放时原样重现
        if (streamError && !isAbort(streamError)) message._error = describeError(streamError);
        messages.push(message);
        yield { type: 'final', message, error: streamError, aborted: isAbort(streamError) };
        return;
      }

      // 模型请求调用工具：assistant(tool_calls) 落历史，每个调用逐一执行并成对回填 tool 消息
      yield { type: 'tool-round', content: acc };
      messages.push({
        role: 'assistant',
        content: acc,
        tool_calls: calls.map((c) => ({
          id: c.id, type: 'function', function: { name: c.name, arguments: c.arguments },
        })),
      });

      // 同一批调用里一旦发生跳转，后续动作的元素编号已全部失效，不能再盲目执行
      let batchBroken = false;
      // 截图的多模态跟随消息（role:'user'）不能就地回填：assistant(tool_calls) 之后
      // 必须是连续等量的 tool 消息，中间插一条 user 会把 tool 链截断，严格后端直接 400。
      // 因此本批先攒着，等所有 tool 消息成对回填完再统一追加到历史末尾（不变式 7）
      const pendingFollowUps = [];
      for (const call of calls) {
        // 未注册的动作不会执行，不按动作行呈现，也不计入摘要里的「页面操作」
        const isAction = WRITE_TOOL_NAMES.has(call.name) && registered.has(call.name);
        // 中止：未执行的调用补占位 tool 消息，tool_calls 必须一一回填，否则历史不合法（下轮 400）
        if (aborted()) {
          messages.push({ role: 'tool', tool_call_id: call.id, content: t('sys.aborted') });
          continue;
        }
        if (batchBroken) {
          const text = t('ui.skipNavigated', { name: call.name });
          messages.push({
            role: 'tool', tool_call_id: call.id,
            content: t('sys.batchBroken'),
            // 活动行文案随消息落库：历史回放时不必重算当时的界面（_ 前缀字段不出网）
            _ui: { text, ok: false, action: isAction },
          });
          yield { type: 'tool-start', name: call.name, isAction, text: '' };
          yield { type: 'tool-done', name: call.name, isAction, ok: false, text, image: '' };
          continue;
        }
        let argsForUi = null;
        try { argsForUi = call.arguments ? JSON.parse(call.arguments) : {}; } catch { /* 文案按 null 兜底 */ }
        yield { type: 'tool-start', name: call.name, isAction, text: describeToolActivity(call.name, argsForUi, 'run') };
        // 同一请求最多一张真图：本批还没回填的那些也算在内，否则一批两次截图会漏网
        if (call.name === 'capture_screenshot') stripImagesFromHistory(messages, pendingFollowUps);
        const { toolMessage, followUpMessage, meta } = await dispatchToolCall(call, provider, turn, registered);
        messages.push(toolMessage);
        let image = '';
        if (followUpMessage) {
          followUpMessage._placeholder = t('sys.shotOmittedMeta', {
            w: meta.data.w, h: meta.data.h, n: meta.data.markCount,
          });
          pendingFollowUps.push(followUpMessage);
          image = imageOf(followUpMessage);
        }
        const text = describeToolActivity(call.name, meta.args || argsForUi, meta.ok ? 'done' : 'fail', meta.data);
        // 定稿的活动行文案随 tool 消息落库，历史回放据此重建一模一样的活动行
        toolMessage._ui = { text, ok: meta.ok, action: isAction };
        yield { type: 'tool-done', name: call.name, isAction, ok: meta.ok, text, image };
        if (meta.data && meta.data.navigated) batchBroken = true;
      }
      // tool 链已完整，此时追加截图的多模态消息才不会截断它
      for (const followUp of pendingFollowUps) messages.push(followUp);

      if (aborted()) {
        // 中止在工具阶段发生：没有最终回复文本，空回复不入历史
        yield { type: 'final', message: { role: 'assistant', content: '' }, error: null, aborted: true };
        return;
      }

      rounds++;
      if (rounds === roundLimit) {
        // 达到上限：下一轮请求不带 tools，并明确告知模型直接作答
        messages.push({ role: 'user', content: t('sys.toolLimit'), _kind: 'tool-limit' });
      }
      yield { type: 'next-round' };
    }
  } finally {
    stripImagesFromHistory(messages); // 回合收尾：历史不保留任何真图
    trimRetainedReads(messages);      // 同理，读到的正文跨回合只保留最近的那些
  }
}

/* ========== 压缩上下文 ========== */

/**
 * 压缩上下文那一轮：另调一次模型，把此前对话收成一份摘要。请求链的组装（含二次压缩只重发
 * 旧摘要）见 core/conversation.js；这一轮不注册 tools（不变式 2）。
 * 失败（含模型不听话仍返回 tool_calls、中止时的半截摘要）一律放弃：半截摘要比不压缩更危险。
 * @param {object} o
 * @param {string} o.instruction 用户随命令给出的摘要指示，可为空
 * @param {Array<object>} o.messages 当前会话的消息数组（不改动）
 * @param {{ summary: string, boundary: number }|null} o.compact 当前压缩状态
 * @param {object} o.profile 接口套
 * @param {AbortSignal} [o.signal]
 * @param {(requestMessages: Array<object>) => void} [o.onRequest] 请求发出前回调（外壳打印核对）
 * @returns {Promise<{ ok: true, compact: object, calibration: number|null }
 *   | { ok: false, aborted: boolean, error: Error|null, errorText: string, calibration: number|null }>}
 *   errorText 为可读失败原因，中止时为空（用户自己停的，不必报错）
 */
export async function requestCompaction({ instruction = '', messages, compact, profile, signal, onRequest }) {
  const requestMessages = buildCompactRequest(instruction, messages, compact);
  if (onRequest) onRequest(requestMessages);

  let summary = '';
  let calls = null;
  let error = null;
  let calibration = null;
  try {
    for await (const ev of streamChat(profile, requestMessages, { signal })) {
      if (ev.type === 'delta') summary += ev.text;
      else if (ev.type === 'tool_calls') calls = ev.calls;
      else if (ev.type === 'usage') calibration = calibrationOf(ev, requestMessages) || calibration;
    }
  } catch (err) {
    error = err;
  }

  if (error || calls || !summary.trim()) {
    const aborted = isAbort(error);
    let errorText = '';
    if (!aborted) {
      // 摘要请求自身超窗：压缩也救不回来了，只剩新对话
      errorText = isContextOverflow(error) ? t('err.contextOverflowCompact')
        : error ? describeError(error) : t('ui.compactBadReply');
    }
    return { ok: false, aborted, error, errorText, calibration };
  }
  return { ok: true, compact: buildCompactState(summary, messages.length), calibration };
}
