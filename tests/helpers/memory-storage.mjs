// tests/helpers/memory-storage.mjs —— 内存版键值存储
//
// 实现外壳注入给 core 的 storage 接口（异步 get / set / remove），替代 chrome.storage.local。
// quotaBytes 模拟配额：写入后总量超出即回滚并抛出与 Chrome 同样措辞的错误，
// 用来验证 core/history.js 在「估算与真实计量有出入」时的淘汰重试。
// 口径同 chrome.storage：每条 = 键长 + 值的 JSON 的 UTF-8 字节数。

const encoder = new TextEncoder();

function entryBytes(key, value) {
  return key.length + encoder.encode(JSON.stringify(value)).length;
}

/**
 * @param {{ quotaBytes?: number, failOn?: (key: string) => Error|null }} [opts]
 *   failOn：按键名注入非配额类的写入失败（返回要抛的错误，或 null 表示照常写入）
 */
export function createMemoryStorage({ quotaBytes = Infinity, failOn = null } = {}) {
  const data = new Map();

  const totalBytes = () => {
    let n = 0;
    for (const [k, v] of data) n += entryBytes(k, v);
    return n;
  };

  return {
    /** 底层数据，断言用；值是存进去那一刻的深拷贝 */
    data,
    totalBytes,

    async get(key) {
      return data.has(key) ? structuredClone(data.get(key)) : undefined;
    },

    async set(key, value) {
      const injected = failOn && failOn(key);
      if (injected) throw injected;
      const had = data.has(key);
      const prev = data.get(key);
      data.set(key, structuredClone(value));
      if (totalBytes() > quotaBytes) {
        if (had) data.set(key, prev);
        else data.delete(key);
        throw new Error('QUOTA_BYTES quota exceeded');
      }
    },

    async remove(key) {
      data.delete(key);
    },
  };
}
