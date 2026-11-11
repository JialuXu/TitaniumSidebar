// core/action-guard.js —— 高风险页内动作的执行前确认：风险判定与门控编排（平台无关层）
//
// 页内动作都经 guardAction：点击与回车先预检（core/actions.js 的 inspect 只报事实：动作触发什么、
// 触发控件叫什么、所在对话框或表单写了什么），这里按名称与语境判定风险；命中规则或模型声明了
// irreversible 就请用户确认。批准后的执行载荷带上预检指纹（expect），等待期间目标或所在对话框变了、
// 或用户在页面上操作过，就不执行。
//
// 硬保证只覆盖「命中规则或模型声明」的动作：无名图标且模型没有声明、脚本里的任意副作用，规则看不见，
// 边界写在 SECURITY.md。词表只在本文件一份。

import { t, q } from './i18n.js';

// 风险类别 → 命令名称里的说法：中文按子串，英文按整词
const RISKS = [
  ['pay', /支付(?!宝)|付款|缴费|充值|\bpay(?:ment)?\b/i],
  ['transfer', /转账|汇款|\btransfer\b|\bwire\b/i],
  ['order', /下单|提交订单|确认订单|立即购买|确认购买|\bplace (?:your )?order\b|\bbuy now\b|\border now\b|\bpurchase\b/i],
  ['approve', /提交审批|送审|审批通过|审核通过|提交审核|批准|驳回|\bapprove\b|\bsubmit for (?:approval|review)\b/i],
  ['delete', /删除(?!线)|清空|移除|\bdelete\b|\bremove\b|\berase\b/i],
  ['send', /发送|\bsend\b/i],
  ['publish', /发布|发表|\bpublish\b|\bpost\b|\btweet\b/i],
  ['authorize', /授权|\bauthori[sz]e\b|\bgrant\b/i],
];

// 发验证码是登录流程里的例行一步，不算对外发送
const VERIFY_CODE = /验证码|校验码|\bcode\b/i;

// 回车发出时只看「发送 / 发布」：输入区附近的按钮里常有消息自带的「删除」
const SEND_RISKS = ['send', 'publish'];

// 对话框或表单里写明的后果
const CONSEQUENCE = /永久|不可恢复|无法恢复|不可撤销|无法撤销|不可撤回|无法撤回|产生费用|扣款|扣费|\bpermanent(?:ly)?\b|cannot be undone|can't be undone|irreversible|will be charged/i;

// 弱信号：名称整体就是一个泛泛的确认词，单独出现不确认，叠加高风险语境或 post 提交才确认
const WEAK = /^(?:确定|确认|提交|好|好的|是|是的|继续|完成|同意|确认提交|确定提交|提交申请|ok|okay|confirm|submit|yes|continue|done|proceed|agree|iagree)$/i;

// 命令名称的长度上限：再长就是内容（新闻标题、邮件主题、整张卡片），不是命令
const MAX_LABEL = 30;

function risksIn(text, only) {
  const out = [];
  if (!text) return out;
  for (const [code, re] of RISKS) {
    if (only && !only.includes(code)) continue;
    if (!re.test(text)) continue;
    if (code === 'send' && VERIFY_CODE.test(text)) continue;
    out.push(code);
  }
  return out;
}

// 回车提交、表单又没有具名的提交按钮：与点一个泛泛的「提交」同等对待
function isWeak(label, via) {
  if (!label) return via === 'submit';
  return WEAK.test(label.replace(/\s+/g, '').replace(/[!！。.]+$/, ''));
}

/**
 * 判定一次页内动作要不要请用户确认。
 * @param {object} info core/actions.js 的 inspect 结果
 * @param {{ declared?: boolean }} [o] declared：模型声明了 irreversible
 * @returns {{ required: boolean, risks: string[] }}
 *   risks：pay | transfer | order | approve | delete | send | publish | authorize（名称或语境里的说法）、
 *          consequence（语境写明后果）、submit（弱信号 + post 提交）、declared（模型声明）
 */
export function classifyAction(info, { declared = false } = {}) {
  const risks = new Set();
  const label = (info && info.label) || '';
  if (info && info.via === 'send') {
    for (const name of info.nearby || []) for (const code of risksIn(name, SEND_RISKS)) risks.add(code);
  } else if (info && info.command && (info.via === 'click' || info.via === 'submit')) {
    if (label.length <= MAX_LABEL) for (const code of risksIn(label)) risks.add(code);
    if (!risks.size && isWeak(label, info.via)) {
      for (const code of risksIn(info.context)) risks.add(code);
      if (CONSEQUENCE.test(info.context || '')) risks.add('consequence');
      if (info.post) risks.add('submit');
    }
  }
  if (declared) risks.add('declared');
  return { required: risks.size > 0, risks: [...risks] };
}

/** 要不要先预检：点击与回车，以及模型声明了不可逆的按键 */
export function needsInspect(payload, declared) {
  if (payload.action === 'click') return true;
  return payload.action === 'key' && (declared || payload.key === 'Enter');
}

/**
 * 确认块上的文案：做什么、可能涉及什么、依据。外壳只负责画。
 * @returns {{ action: string, reason: string, details: string[] }}
 */
export function describeRequest(payload, info, risks, step) {
  // 点击的名称与活动行同一写法（[12] "删除"）；按键写焦点落在哪个输入区
  let action = payload.action === 'click'
    ? t('guard.click', { ref: payload.ref, name: info.name ? ` "${info.name}"` : '' })
    : t('guard.key', { key: payload.key, name: info.name ? t('guard.on', { name: q(info.name) }) : '' });
  if (step) action = t('guard.step', { n: step }) + action;
  const reason = t('guard.reason', { risks: risks.map((code) => t('guard.risk.' + code)).join(t('guard.sep')) });
  const details = [];
  if (info.via === 'submit') details.push(t('guard.viaSubmit', { name: info.label ? q(info.label) : t('guard.noLabel') }));
  if (info.via === 'send') details.push(t('guard.viaSend'));
  if (info.context) details.push(t('guard.context', { text: info.context.length > 120 ? info.context.slice(0, 120) + '…' : info.context }));
  return { action, reason, details };
}

/**
 * 门控：需要确认的动作，用户批准后才执行，且执行时复验通过（见 core/actions.js 的 verifyExpect）。
 * 拒绝、中止、没有确认渠道都不调用 execute。批准只放行这一次 await，不留可重放的凭证。
 * @param {object} o
 * @param {object} o.payload                provider.act 的载荷
 * @param {boolean} [o.declared]            模型声明了 irreversible
 * @param {((payload: object) => Promise<object>)|null} o.inspect   预检（performAction 的 inspect）
 * @param {((request: object, signal?: AbortSignal) => Promise<boolean>)|null} [o.confirm]  请用户确认
 * @param {(payload: object) => Promise<{ result: object, change: object|null }>} o.execute
 * @param {Set<string>} [o.denials]         本回合被拒过的动作（同一目标、同一指纹不再弹窗）
 * @param {AbortSignal} [o.signal]
 * @param {number} [o.step]                 批量动作里的第几步（从 1 起）
 * @returns {Promise<{ result: object|null, change: object|null }>}
 *   未执行时 result 为 { ok: false, reason: denied | changed / touched（执行时复验）| unconfirmed | aborted | 预检的失败原因 }
 */
export async function guardAction({ payload, declared = false, inspect, confirm, execute, denials, signal, step }) {
  const refuse = (reason) => ({ result: { ok: false, reason }, change: null });
  // 停止之后一步也不再开始：批量动作的每一步都经过这里，回合循环只在两次工具调用之间查中止
  if (signal && signal.aborted) return refuse('aborted');
  if (!needsInspect(payload, declared)) return execute(payload);
  if (typeof inspect !== 'function') return refuse('unconfirmed');
  const info = await inspect(payload);
  // 预检期间点了停止：无论要不要确认都不执行
  if (signal && signal.aborted) return refuse('aborted');
  // 预检失败（编号过期、元素消失或不可见）：执行也会以同样的原因失败
  if (!info || !info.ok) return { result: info || null, change: null };
  const { required, risks } = classifyAction(info, { declared });
  if (!required) return execute(payload);

  // 拒绝记录按目标记：列表每行的「删除」名称与语境都相同，指纹一样，靠编号区分；不带编号的回车取焦点元素的编号
  const key = [payload.action, payload.ref ?? info.targetRef ?? '', info.print].join('\u0002');
  if (denials && denials.has(key)) return refuse('denied');
  if (typeof confirm !== 'function') return refuse('unconfirmed');
  let approved;
  try {
    approved = await confirm(describeRequest(payload, info, risks, step), signal);
  } catch {
    return refuse('unconfirmed');
  }
  if (signal && signal.aborted) return refuse('aborted');
  if (!approved) {
    if (denials) denials.add(key);
    return refuse('denied');
  }
  return execute({ ...payload, expect: info.print });
}
