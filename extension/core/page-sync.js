// core/page-sync.js —— 发送前的页面同步：决定本条消息携带什么（平台无关层）
//
// 每条消息发送前外壳重读一次当前页面，再与「模型上次实际看到的那份」sentPage 比对：
//   none       页面没变            → 什么都不带，沿用历史里的那一份
//   diff       同一网址、小幅变化  → 只带几十行差异摘要
//   full       首次 / 换页 / 大改  → 带最新全文（历史里更早的全文随后被压成占位）
//   unreadable 当前页读不到        → 不带内容；此前读过页面时交代一句免得模型拿旧页当现状
// 比对基准是 sentPage 而不是当前页面状态：AI 操作导致跳转时当前页早已换成新页，
// 只有 sentPage 记得模型手里停在哪一页（不变式 6）。
// unreadable 由外壳在快照失败时直接给出（{ kind: 'unreadable', changed }），
// 其余三种由 decidePageSync 判定；本模块只做纯数据判定与组装，读页面与落库都在外壳。

import { t } from './i18n.js';
import { formatTextDiff } from './format.js';
import { buildUserContent, buildPageUpdate } from './prompt.js';

// 会话中累计的差异摘要上限：超过这个量说明页面已经改得面目全非，
// 与其继续叠碎片，不如重发一次全文，让模型手上是一份完整的当前页面。
const MAX_DIFF_CHARS = 4000;

/**
 * 模型「已经看到的页面」的初值：url 为空表示还没给模型看过任何页面。
 * 不能拿 text 判断：只有控件、没有正文的页面 text 本来就是空的。
 * textTotal 是模型看到的那份页面有多长，位置是否还作数以它为基准（不变式 6），
 * 因此只在真的重发了全文（kind:'full'）时更新。
 */
export function initialSentPage() {
  return { text: '', outline: '', url: '', title: '', diffChars: 0, textTotal: 0, textCapped: false };
}

/**
 * 比对最新快照与 sentPage，判定携带方式。
 * @param {object} sentPage 模型上次实际看到的页面（initialSentPage 的形状，可带 gone 标记）
 * @param {{ url: string, maskedText: string }} page 最新快照（脱敏后）
 * @param {boolean} loading 读取时页面是否仍在加载，随判定结果带出去
 * @returns {{ kind: 'none'|'diff'|'full', first?: boolean, navigated?: boolean, loading?: boolean, diff?: string }}
 */
export function decidePageSync(sentPage, page, loading) {
  if (!sentPage.url) return { kind: 'full', first: true, loading };
  // 上一条消息告诉过模型「用户切到了读不到的页面」，现在又读到了：哪怕内容与那时一字不差
  // 也要重发一份，否则模型会一直以为用户还停在受限页上
  if (sentPage.gone) return { kind: 'full', navigated: sentPage.url !== page.url, loading };
  if (sentPage.url !== page.url) return { kind: 'full', navigated: true, loading };
  if (sentPage.text === page.maskedText) return { kind: 'none' };
  const diff = formatTextDiff(sentPage.text, page.maskedText);
  if (diff && sentPage.diffChars + diff.length <= MAX_DIFF_CHARS) return { kind: 'diff', diff, loading };
  return { kind: 'full', loading };
}

/**
 * 按判定结果组装本条用户消息的真实内容，并给出更新后的「模型已经看到的页面」。
 * @param {string} inputText 用户输入
 * @param {object} page 最新快照：{ maskedText, outlineText, url, title, textTotal, textShown, textCapped }
 * @param {object} sentPage 当前的 sentPage
 * @param {object} sync decidePageSync 的结果，或外壳给出的 unreadable
 * @returns {{ content: string, sentPage: object }}
 */
export function composeSendContent(inputText, page, sentPage, sync) {
  let next = sentPage;
  if (sync.kind === 'full' || sync.kind === 'diff') {
    // 带了差异也算模型已看到最新内容：下次以当前页面为基准比对，差异不会重复累计。
    // 整体重建对象也顺带清掉 gone 标记——模型手上又有页面了
    next = {
      text: page.maskedText, outline: page.outlineText, url: page.url, title: page.title,
      diffChars: sync.kind === 'diff' ? sentPage.diffChars + sync.diff.length : 0,
      // 差异块不重发骨架也不重发全文，模型手里那份页面的长度没变，基准照旧
      textTotal: sync.kind === 'full' ? page.textTotal : sentPage.textTotal,
      textCapped: sync.kind === 'full' ? page.textCapped : sentPage.textCapped,
    };
  }
  // 页面块之前的交代语：换页、仍在加载，各一句，可叠加
  const lead = [
    sync.kind === 'full' && sync.navigated ? t('prompt.leadSwitched') : '',
    sync.loading ? t('prompt.leadLoading') : '',
  ].filter(Boolean).join('\n');
  if (sync.kind === 'full') {
    const content = buildUserContent(
      inputText, page.maskedText, page.outlineText, lead,
      page.textTotal ? { total: page.textTotal, shown: page.textShown, capped: page.textCapped } : null
    );
    return { content, sentPage: next };
  }
  if (sync.kind === 'diff') return { content: buildPageUpdate(inputText, sync.diff, lead), sentPage: next };
  if (sync.kind === 'unreadable' && sync.changed) {
    // 记下「已告诉模型页面没了」，等页面重新可读时无条件重发（见 decidePageSync）
    return { content: `${t('prompt.leadPageGone')}\n\n${inputText}`, sentPage: { ...sentPage, gone: true } };
  }
  return { content: inputText, sentPage: next };
}
