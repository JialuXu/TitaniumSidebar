// core/history.js —— 历史会话存储（平台无关层）
//
// 职责：把「一段会话」作为普通数据落进外壳注入的 storage，并维护一份轻量索引。
//   - 索引与记录分键存放：history.index 只存 { id, title, createdAt, updatedAt, turns }，
//     打开历史列表时不必加载任何会话正文；完整记录存在 history.session.<id> 下。
//   - 上限淘汰：会话数超过 maxSessions、或历史总字节数超过 maxBytes 时自动删除最旧的记录。
//     只按条数不够：几段带长页面的会话就能把 chrome.storage.local（约 10MB 配额）撑满，
//     届时不止历史存不进去，连设置也保存不了——所以 maxBytes 要给配置留出余量。
//     字节估算与真实计量总有出入，写入仍报配额满时再淘汰最旧的一条重试，直到只剩本条。
//   - 存储层不理解消息结构：messages/sentPage/skillId/compact 给什么存什么，
//     只要求 JSON 可序列化。记录的组装（标题、轮数）在 buildSessionRecord；
//     回放逻辑（把消息数组重建成 UI）在外壳，不在这里。
//
// storage 接口在 config 存储的 get/set 之外多要求一个 remove(key)——
// 扩展外壳用 chrome.storage.local.remove 实现，SDK 外壳将来用 localStorage.removeItem。

import { t } from './i18n.js';
import { isUserInput } from './conversation.js';

/** 记录格式版本：结构不兼容地演进时递增，load 端对不上的记录按不存在处理 */
export const HISTORY_RECORD_VERSION = 1;

/** 生成会话 id：时间戳保证大体有序，随机尾巴防同毫秒冲突 */
export function newSessionId() {
  return Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 8);
}

/**
 * 从首条用户消息推导会话标题：压缩空白、截断到 maxLen。
 * 不调用模型起标题——「不发消息就不产生网络请求」的承诺同样适用于历史功能。
 */
export function deriveSessionTitle(text, maxLen = 60) {
  const s = String(text || '').replace(/\s+/g, ' ').trim();
  return s.length > maxLen ? s.slice(0, maxLen) + '…' : s;
}

/** 会话轮数 = 用户真实发出的消息数 */
export function countTurns(messages) {
  return (messages || []).filter(isUserInput).length;
}

/**
 * 组装一条会话记录（save 的入参）。调用方保证会话里至少有一条用户消息，标题取第一条。
 * messages 是回合收尾后的形态：截图已换成占位，`_` 前缀字段一并保存供回放（发请求前才剔除）。
 * @param {object} s
 * @param {string} s.id 会话 id（首次保存时由调用方 newSessionId 生成）
 * @param {number} s.createdAt
 * @param {number} s.updatedAt
 * @param {Array<object>} s.messages
 * @param {object} s.sentPage 恢复后发送前的页面比对要以它为基准
 * @param {string|null} s.skillId 技能是会话属性，随会话保存与恢复
 * @param {{ summary: string, boundary: number }|null} s.compact 恢复后界面回放原文，请求链仍走摘要。
 *   缺 compact 的旧记录按未压缩处理，因此 HISTORY_RECORD_VERSION 不必递增
 */
export function buildSessionRecord({ id, createdAt, updatedAt, messages, sentPage, skillId, compact }) {
  const first = messages.find(isUserInput);
  return {
    v: HISTORY_RECORD_VERSION,
    id,
    createdAt,
    updatedAt,
    title: deriveSessionTitle(first ? first.displayContent : ''),
    turns: countTurns(messages),
    messages,
    sentPage,
    skillId,
    compact,
  };
}

/**
 * 历史列表里的相对时间：近的说人话，远的落到日期（按本地时区）。
 * @param {number} ts 会话的更新时间
 * @param {number} [now]
 */
export function formatHistoryTime(ts, now = Date.now()) {
  const diff = now - ts;
  if (diff < 60000) return t('ui.timeJustNow');
  if (diff < 3600000) return t('ui.timeMinutesAgo', { n: Math.floor(diff / 60000) });
  const d = new Date(ts);
  const n = new Date(now);
  if (d.toDateString() === n.toDateString()) {
    return t('ui.timeHoursAgo', { n: Math.floor(diff / 3600000) });
  }
  if (d.toDateString() === new Date(now - 86400000).toDateString()) return t('ui.timeYesterday');
  const parts = { y: d.getFullYear(), m: d.getMonth() + 1, d: d.getDate() };
  return t(parts.y === n.getFullYear() ? 'ui.timeDate' : 'ui.timeDateFull', parts);
}

/**
 * 配额满的判定：chrome.storage 报「QUOTA_BYTES quota exceeded」，localStorage 抛 QuotaExceededError。
 * 只有这类错误才值得靠淘汰旧会话腾地方——别的错误（不可序列化等）删多少条都没用，
 * 白白丢掉用户的历史。
 */
export function isQuotaError(err) {
  return Boolean(err) && (err.name === 'QuotaExceededError' || /quota/i.test(String(err.message || '')));
}

/** 本条记录单独就超出历史预算：淘汰其他会话也存不下，直接放弃并告诉调用方 */
export class HistoryTooLargeError extends Error {
  constructor(bytes) {
    super(`history record too large (${bytes} bytes)`);
    this.name = 'HistoryTooLargeError';
    this.bytes = bytes;
  }
}

// 一条键值占用的字节数，口径同 chrome.storage：键长 + 值的 JSON 的 UTF-8 字节数
const encoder = new TextEncoder();
function entryBytes(key, value) {
  return key.length + encoder.encode(JSON.stringify(value)).length;
}

/**
 * 创建历史会话存储。
 * @param {{get:Function, set:Function, remove:Function}} storage 外壳注入的异步键值存储
 * @param {{maxSessions?: number, maxBytes?: number}} opts
 *   maxSessions：保留的会话上限；maxBytes：全部会话记录的字节预算。超任一项都淘汰最旧
 */
export function createHistoryStore(storage, { maxSessions = 50, maxBytes = Infinity } = {}) {
  const INDEX_KEY = 'history.index';
  const recordKey = (id) => `history.session.${id}`;

  // 旧版索引项没有 bytes：读一次记录补上，随下一次写索引持久化（每条只补一次）
  async function fillBytes(index) {
    for (const e of index) {
      if (typeof e.bytes === 'number') continue;
      const record = await storage.get(recordKey(e.id));
      e.bytes = record ? entryBytes(recordKey(e.id), record) : 0;
    }
  }

  // 淘汰：先把它们移出索引再删记录——中途失败只留下列表里看不见的孤儿，不留空悬项
  async function evict(index, victims) {
    if (!victims.length) return;
    const gone = new Set(victims.map((e) => e.id));
    await storage.set(INDEX_KEY, index.filter((e) => !gone.has(e.id)));
    for (const e of victims) await storage.remove(recordKey(e.id));
  }

  return {
    /** 索引列表，最近更新的在前；从未保存过时返回空数组 */
    async list() {
      return (await storage.get(INDEX_KEY)) || [];
    },

    /** 载入完整记录；不存在或版本不兼容返回 null */
    async load(id) {
      const record = (await storage.get(recordKey(id))) || null;
      return record && record.v === HISTORY_RECORD_VERSION ? record : null;
    },

    /**
     * 保存（新建或覆盖）一条会话记录，并把索引项挪到最前。
     * 顺序：先按条数与字节预算淘汰最旧的会话腾出空间，再写记录，最后写索引。
     * 写记录失败时索引里仍是旧版本的条目（旧记录还在），不会出现空悬项；
     * 写索引失败留下的孤儿记录对列表不可见，比「索引里有、记录读不到」更无害。
     * 本条单独就超预算时抛 HistoryTooLargeError，其他会话一条不动。
     */
    async save(record) {
      const key = recordKey(record.id);
      const bytes = entryBytes(key, record);
      if (bytes > maxBytes) throw new HistoryTooLargeError(bytes);

      const index = (await storage.get(INDEX_KEY)) || [];
      await fillBytes(index);
      // 本条的旧版本即将被覆盖，不参与淘汰；其余按从新到旧排
      const others = index.filter((e) => e.id !== record.id);
      let keep = others.length;
      let total = bytes;
      for (let i = 0; i < others.length; i++) {
        if (i >= maxSessions - 1 || total + others[i].bytes > maxBytes) { keep = i; break; }
        total += others[i].bytes;
      }
      await evict(index, others.slice(keep));
      let kept = others.slice(0, keep);

      // 估算与真实计量有出入：仍报配额满就再淘汰最旧的一条重试
      for (;;) {
        try {
          await storage.set(key, record);
          break;
        } catch (err) {
          if (!isQuotaError(err) || !kept.length) throw err;
          const current = index.filter((e) => e.id === record.id);
          await evict([...current, ...kept], kept.slice(-1));
          kept = kept.slice(0, -1);
        }
      }

      const next = [{
        id: record.id,
        title: record.title,
        createdAt: record.createdAt,
        updatedAt: record.updatedAt,
        turns: record.turns,
        bytes,
      }, ...kept];
      await storage.set(INDEX_KEY, next);
      return next;
    },

    /** 删除一条会话，返回删除后的索引 */
    async remove(id) {
      const index = ((await storage.get(INDEX_KEY)) || []).filter((e) => e.id !== id);
      await storage.set(INDEX_KEY, index);
      await storage.remove(recordKey(id));
      return index;
    },

    /** 清空全部历史会话 */
    async clear() {
      const index = (await storage.get(INDEX_KEY)) || [];
      for (const e of index) await storage.remove(recordKey(e.id));
      await storage.set(INDEX_KEY, []);
    },
  };
}
