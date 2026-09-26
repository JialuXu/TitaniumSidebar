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
// 读页面用到的约定也在这里：完整快照的参数、等内容就位的预算、快照 → 页面状态（脱敏后）。

import { t, injectedStrings } from './i18n.js';
import { formatTextDiff, formatOutline, BUDGETS } from './format.js';
import { maskSensitive } from './masker.js';
import { buildUserContent, buildPageUpdate } from './prompt.js';

// 会话中累计的差异摘要上限：超过这个量说明页面已经改得面目全非，
// 与其继续叠碎片，不如重发一次全文，让模型手上是一份完整的当前页面。
const MAX_DIFF_CHARS = 4000;

/* ========== 读页面的约定 ========== */

/** 可交互元素编号的保险丝：防失控的宽松上限，不是 token 预算（见 CLAUDE.md 第 2 节） */
export const MAX_ELEMENTS = 1500;

/**
 * 「读一份完整页面」的 snapshotPage 参数。发送前重读与动作跳转后的重建必须传同一套，
 * 否则正文总字数、截断点这些口径会在两条路径上悄悄分叉。
 * maxScan 是「采到完整正文」的开关：只要元素映射的全量重建不传它，采不到全文，
 * stats 里也就不会出现 textTotal，免得报出假的总字数。
 * @param {object} [extra] 追加参数，如 { inheritRefs: true }
 */
export function fullSnapshotArgs(extra = {}) {
  return {
    mode: 'full',
    maxTextLen: BUDGETS.text,
    maxScan: BUDGETS.scan,
    maxElements: MAX_ELEMENTS,
    i18n: injectedStrings(),
    ...extra,
  };
}

/**
 * 「等页面内容就位」的预算（waitForSettle 的参数）。文档 complete 不等于内容就位：
 * SPA 与后台系统的数据随后才由接口拉回，这段时间页面上是骨架屏与「暂无数据」占位，
 * 此刻拍快照模型就会把占位当结论。发送前的等待要快（用户在等回复）；动作后可以多等一会，那是模型在等。
 */
export const SETTLE = {
  send: { quietMs: 400, maxMs: 2500 },
  action: { quietMs: 600, maxMs: 5000 },
};

/**
 * 稳定判定 → 「仍在加载」标记（decidePageSync 与 formatPageChange 据此提醒模型）。
 * 稳定了或没判定成功都是 null：判定不了不能当「仍在加载」到处报警。
 * @param {{ settled: boolean, busy: boolean, waitedMs: number }|null} settle waitForSettle 的返回值
 */
export function loadingOf(settle) {
  if (!settle || settle.settled) return null;
  return { busy: settle.busy, waitedMs: settle.waitedMs };
}

/* ========== 页面状态 ========== */

/**
 * 页面状态的初值：还没读过。外壳持有的「当前页面」就是这个形状，
 * 面板展示、引用校验与 ref 映射都以它为依据。
 */
export function initialPage() {
  return {
    status: 'none',          // none 未读取 | ok 已读取 | unreadable 无法读取
    title: '',
    url: '',
    maskedText: '',          // 脱敏后的页面文本：注入 prompt 与引用校验共用同一份
    outlineText: '',         // 脱敏后的结构骨架文本（注入 prompt + 详情面板展示）
    elementCount: 0,         // 快照时的可交互元素数（状态条展示）
    textTotal: 0,            // 完整正文字数（未截断时为 0）：胶囊展示 + 位置漂移判定
    textShown: 0,            // 其中已注入给模型的前多少字
    textCapped: false,       // 正文超出采集上限，总字数只是「至少这么多」
    session: '',             // ref 映射的会话标识，页面侧 window.__titanium 持有同名值
    // 工作标签页：快照来源，也是所有感知与动作的作用对象。
    // open_tab/switch_tab 会把它转移到新标签页并同步激活，「激活页 === 工作页」始终成立（不变式 5）
    tabId: null,
    hits: null,              // 脱敏命中计数 { idCard, bankCard, phone }，未开脱敏为 null
  };
}

/**
 * 一次完整快照 → 页面状态。发送前的例行重读与动作导致跳转后的重建共用这一份，避免两处规则漂移。
 * 文本与结构骨架都走文本通道，发给模型前必须一并脱敏；命中数合并计入徽标。
 * @param {object} snap snapshotPage({ mode: 'full' }) 的返回值
 * @param {{ tabId: *, mask: boolean }} opts
 */
export function pageFromSnapshot(snap, { tabId, mask }) {
  const outlineRaw = formatOutline(snap.outline, { dropped: snap.stats.outlineDropped });
  const textRes = mask ? maskSensitive(snap.text) : { text: snap.text, hits: null };
  const outlineRes = mask ? maskSensitive(outlineRaw) : { text: outlineRaw, hits: null };
  return {
    status: 'ok',
    title: snap.title,
    url: snap.url,
    maskedText: textRes.text,
    outlineText: outlineRes.text,
    elementCount: snap.stats.totalElements,
    textTotal: snap.stats.textTruncated ? snap.stats.textTotal : 0,
    textShown: snap.stats.textShown || 0,
    textCapped: Boolean(snap.stats.textCapped),
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

/* ========== 同步判定 ========== */

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

/**
 * 消息流里交代这次同步的那行浅色小字。只有页面在会话中途真的变了才提示，
 * 首次读取由页面胶囊出现即可说明；读取时仍在加载也要让用户知道，
 * 否则回答里的「暂无数据」看起来像是 AI 读错了。没什么可交代时返回空串。
 * @param {object} sync decidePageSync 的结果，或外壳给出的 unreadable
 * @param {string} title 换页时显示的页面标题（外壳按胶囊宽度截好）
 */
export function describeSyncNote(sync, title) {
  let note = '';
  if (sync.kind === 'full' && sync.navigated) note = t('ui.notePageNavigated', { title });
  else if (sync.kind === 'full' && !sync.first) note = t('ui.notePageReread');
  else if (sync.kind === 'diff') note = t('ui.notePageUpdated');
  else if (sync.kind === 'unreadable' && sync.changed) note = t('ui.notePageUnreadable');
  if (sync.loading) note = note ? `${note} · ${t('ui.notePageLoading')}` : t('ui.notePageLoading');
  return note;
}
