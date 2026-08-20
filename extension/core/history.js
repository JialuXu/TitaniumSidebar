// core/history.js —— 历史会话存储（平台无关层）
//
// 职责：把「一段会话」作为普通数据落进外壳注入的 storage，并维护一份轻量索引。
//   - 索引与记录分键存放：history.index 只存 { id, title, createdAt, updatedAt, turns }，
//     打开历史列表时不必加载任何会话正文；完整记录存在 history.session.<id> 下。
//   - 上限淘汰：会话数超过 maxSessions 时自动删除最旧的记录，防止把
//     chrome.storage.local（约 10MB 配额）默默撑爆。
//   - 本模块不理解消息结构：messages/sentPage/skillId 都是外壳给什么存什么，
//     只要求 JSON 可序列化。回放逻辑（把消息数组重建成 UI）在外壳，不在这里。
//
// storage 接口在 config 存储的 get/set 之外多要求一个 remove(key)——
// 扩展外壳用 chrome.storage.local.remove 实现，SDK 外壳将来用 localStorage.removeItem。

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

/** 会话轮数 = 用户真实发出的消息数（displayContent 仅存在于用户敲入的消息上） */
export function countTurns(messages) {
  return (messages || []).filter((m) => m.role === 'user' && m.displayContent !== undefined).length;
}

/**
 * 创建历史会话存储。
 * @param {{get:Function, set:Function, remove:Function}} storage 外壳注入的异步键值存储
 * @param {{maxSessions?: number}} opts 保留的会话上限，超限淘汰最旧
 */
export function createHistoryStore(storage, { maxSessions = 50 } = {}) {
  const INDEX_KEY = 'history.index';
  const recordKey = (id) => `history.session.${id}`;

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
     * 先写记录再写索引：写记录失败（配额）时索引不变；写索引失败留下的
     * 孤儿记录对列表不可见，比「索引里有、记录读不到」的空悬项更无害。
     */
    async save(record) {
      await storage.set(recordKey(record.id), record);
      let index = ((await storage.get(INDEX_KEY)) || []).filter((e) => e.id !== record.id);
      index.unshift({
        id: record.id,
        title: record.title,
        createdAt: record.createdAt,
        updatedAt: record.updatedAt,
        turns: record.turns,
      });
      const evicted = index.slice(maxSessions);
      index = index.slice(0, maxSessions);
      await storage.set(INDEX_KEY, index);
      for (const e of evicted) await storage.remove(recordKey(e.id));
      return index;
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
