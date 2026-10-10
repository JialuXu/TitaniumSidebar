// core/key-effect.js —— 由按键前后两次快照得出按键的实际效果（平台无关层）
//
// 调试通道发的是真实按键，浏览器自己执行默认行为；按键的效果靠 performAction 的 probe
// 前后各取一次比较得出。产出与合成事件通道的 keyDefault 同一形状，工具结果的文案共用一套
// （见 core/tools.js 的 keyEffectText）。

/**
 * @param {object|null} before probe 结果
 * @param {object|null} after probe 结果
 * @returns {{ kind: 'caret'|'scroll'|'delete', moved: boolean, from?: number, to?: number,
 *             px?: number, where?: 'field'|'area'|'page', removed?: number } | null}
 *   快照缺失时返回 null（说不清效果就不说）
 */
export function keyEffectFromProbes(before, after) {
  if (!before || !after || !before.ok || !after.ok) return null;
  const diff = (k) => (typeof before[k] === 'number' && typeof after[k] === 'number' ? after[k] - before[k] : 0);
  // 焦点换了人（Tab、回车提交后跳走）：光标与滚动的比较没有意义
  if (before.active !== after.active) return null;
  if (typeof before.length === 'number' && typeof after.length === 'number' && after.length < before.length) {
    return { kind: 'delete', moved: true, removed: before.length - after.length };
  }
  if (before.field && after.field) {
    const px = diff('fieldTop');
    return { kind: 'caret', moved: before.caret !== after.caret || px !== 0, from: before.caret, to: after.caret, px };
  }
  const area = diff('areaTop');
  if (area) return { kind: 'scroll', moved: true, where: 'area', px: area };
  const page = diff('pageTop');
  return { kind: 'scroll', moved: page !== 0, where: 'page', px: page };
}
