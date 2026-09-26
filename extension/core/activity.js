// core/activity.js —— 工具调用活动行文案（平台无关层）
//
// 消息流里每次工具调用以一行活动文案呈现：进行中「正在搜索…」→ 定稿「已搜索：3 处匹配」。
// 按工具名与阶段取词：run/fail 阶段只有调用参数，done 阶段以 dispatchToolCall 回传的
// meta.data 为准。定稿文案随 tool 消息落库（外壳的 `_ui` 字段），历史回放原样重现。
// 过程时间轴收尾时的摘要行（describeTrace）也在这里。
// 图标不在这里：SVG 路径是外壳的界面资产，按工具名另取。

import { t } from './i18n.js';

/**
 * @param {string} name 工具名
 * @param {object|null} args 调用参数（坏 JSON 时为 null，文案按空值兜底）
 * @param {'run'|'done'|'fail'} phase
 * @param {object} [data] done/fail 阶段 dispatchToolCall 回传的 meta.data
 */
export function describeToolActivity(name, args, phase, data = {}) {
  const a = args || {};
  const ref = data.ref ?? a.ref ?? '?';
  const named = data.name ? ` "${data.name}"` : '';
  const jumped = data.navigated ? t('act.jumped') : '';
  // 未注册的调用根本没执行，按工具名套「点击失败」之类的文案会让人以为页面被动过
  if (phase === 'fail' && data.reason === 'not-registered') return t('act.notRegistered', { name });
  switch (name) {
    /* —— 感知类 —— */
    case 'find_in_page': {
      const query = phase === 'done' ? data.query : (a.query || '');
      if (phase === 'run') return t('act.find.run', { query });
      if (phase === 'fail') return t('act.find.fail', { query });
      if (!data.total) return t('act.find.none', { query });
      return t(data.total === 1 ? 'act.find.one' : 'act.find.done', { query, total: data.total });
    }
    case 'read_page_text': {
      if (phase === 'run') return t('act.read.run');
      if (phase === 'fail') return t('act.read.fail');
      return t(data.section ? 'act.read.doneIn' : 'act.read.done', {
        section: data.section, start: data.start, end: data.end,
      });
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
    case 'wait_for_page':
      if (phase === 'run') return t('act.wait.run');
      if (phase === 'fail') return t('act.wait.fail');
      return t('act.wait.done', { s: data.seconds, settled: t(data.settled ? 'act.wait.settled' : 'act.wait.unsettled') });

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

/**
 * 过程时间轴的摘要行：「已执行 N 步，含 M 次页面操作，K 步失败」，没有的部分不写。
 * @param {{ steps: number, actions?: number, failed?: number }} counts
 */
export function describeTrace({ steps, actions = 0, failed = 0 }) {
  let text = t(steps === 1 ? 'ui.traceStep' : 'ui.traceSteps', { n: steps });
  if (actions) text += t(actions === 1 ? 'ui.traceAction' : 'ui.traceActions', { n: actions });
  if (failed) text += t('ui.traceFailed', { n: failed });
  return text;
}
