// core/llm-client.js —— OpenAI 兼容接口调用与 SSE 流式解析（平台无关层）
//
// 只依赖标准 fetch，不依赖扩展的 CORS 豁免（接口地址由外壳传入；
// SDK 场景下 CORS 由网关开放或宿主同域反代解决，core 不关心）。
// 错误统一抛结构化的 LlmError，可读文案映射是外壳的职责（describeError），
// 本文件不含任何面向用户的文案——LlmError.message 只是调试串，不进 UI。

/**
 * 结构化错误。kind 取值：
 *   badconfig — 配置缺失（baseUrl/model 为空）
 *   network   — fetch 本身失败（断网、域名不可达等）
 *   http      — 收到非 2xx 响应（带 status 与响应体 detail）
 *   stream    — 响应流提前中断（未见 [DONE] / finish_reason）
 *   abort     — 调用方主动中止（用户点了停止）
 */
export class LlmError extends Error {
  constructor(kind, { status = 0, detail = '' } = {}) {
    super(`LLM request failed: ${kind}${status ? ' ' + status : ''}`);
    this.name = 'LlmError';
    this.kind = kind;
    this.status = status;
    this.detail = detail;
  }
}

// 规整接口地址：去掉尾部斜杠后拼接 /chat/completions
function chatUrl(baseUrl) {
  return baseUrl.replace(/\/+$/, '') + '/chat/completions';
}

function buildHeaders(config) {
  const headers = { 'Content-Type': 'application/json' };
  if (config.apiKey) headers['Authorization'] = `Bearer ${config.apiKey}`;
  return headers;
}

/**
 * 流式对话（异步生成器），yield 结构化事件：
 *   { type: 'delta', text }                          —— 正文增量（choices[0].delta.content）
 *   { type: 'tool_calls', calls: [{ id, name, arguments }] }
 *     —— 模型请求调用工具；流式分片已拼装完整，arguments 为 JSON 字符串，
 *        该事件最多出现一次且出现后流即结束
 * @param {{ baseUrl: string, model: string, apiKey?: string }} config
 * @param {Array<object>} messages OpenAI 格式消息数组（可含 tool_calls / role:'tool' / 多模态 content）
 * @param {{ signal?: AbortSignal, tools?: Array<object> }} [options]
 *   signal 外壳持有对应 AbortController 实现「停止生成」；tools 为 OpenAI 工具定义，缺省不带
 */
export async function* streamChat(config, messages, { signal, tools } = {}) {
  if (!config || !config.baseUrl || !config.model) throw new LlmError('badconfig');

  let resp;
  try {
    resp = await fetch(chatUrl(config.baseUrl), {
      method: 'POST',
      headers: buildHeaders(config),
      body: JSON.stringify({
        model: config.model,
        messages,
        stream: true,
        ...(tools && tools.length ? { tools } : {}),
      }),
      signal,
    });
  } catch (err) {
    throw new LlmError(err && err.name === 'AbortError' ? 'abort' : 'network');
  }
  if (!resp.ok) {
    const detail = await resp.text().catch(() => '');
    throw new LlmError('http', { status: resp.status, detail });
  }
  if (!resp.body) throw new LlmError('stream');

  const reader = resp.body.getReader();
  const decoder = new TextDecoder();
  let buf = '';
  let cleanEnd = false; // 是否见到 [DONE] 或 finish_reason，用于识别服务端提前断流
  // 流式 tool_calls 分片累积槽：以分片的 index 为下标，id 赋值、name/arguments 字符串累加。
  // 不能假设一个 chunk 到齐——不同实现（DeepSeek/各网关）的分片粒度不一。
  const pending = [];
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buf += decoder.decode(value, { stream: true });
      const lines = buf.split('\n');
      buf = lines.pop(); // 末段可能是半行，留在缓冲区等下一个 chunk
      for (const rawLine of lines) {
        const line = rawLine.replace(/\r$/, '');
        if (!line.startsWith('data:')) continue; // 空行与注释行（keep-alive）跳过
        const payload = line.slice(5).trim();
        if (payload === '[DONE]') {
          cleanEnd = true;
          return;
        }
        let parsed;
        try {
          parsed = JSON.parse(payload);
        } catch {
          continue; // 容忍个别脏行
        }
        const choice = parsed.choices && parsed.choices[0];
        if (!choice) continue;
        const delta = choice.delta || {};
        if (Array.isArray(delta.tool_calls)) {
          for (const frag of delta.tool_calls) {
            const idx = typeof frag.index === 'number' ? frag.index : 0;
            const slot = pending[idx] || (pending[idx] = { id: '', name: '', arguments: '' });
            if (frag.id) slot.id = frag.id;
            if (frag.function && frag.function.name) slot.name += frag.function.name;
            if (frag.function && frag.function.arguments) slot.arguments += frag.function.arguments;
          }
        }
        if (delta.content) yield { type: 'delta', text: delta.content };
        if (choice.finish_reason) {
          cleanEnd = true; // 兼容不发 [DONE] 的网关
          // 宽容处理：只要攒到了分片就交给调用方，不苛求 finish_reason === 'tool_calls'
          //（部分网关对工具调用也报 'stop'）。交付后流即视为结束。
          if (pending.some(Boolean)) {
            yield { type: 'tool_calls', calls: pending.filter(Boolean) };
            return;
          }
        }
      }
    }
    if (!cleanEnd) throw new LlmError('stream');
  } catch (err) {
    if (err instanceof LlmError) throw err;
    throw new LlmError(err && err.name === 'AbortError' ? 'abort' : 'stream');
  } finally {
    reader.cancel().catch(() => {});
  }
}

/**
 * 「测试连接」：发一条 max_tokens: 1 的非流式请求验证连通性，内置 10 秒超时。
 * 成功正常返回；失败抛 LlmError。
 */
export async function testConnection(config) {
  if (!config || !config.baseUrl || !config.model) throw new LlmError('badconfig');
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 10000);
  let resp;
  try {
    resp = await fetch(chatUrl(config.baseUrl), {
      method: 'POST',
      headers: buildHeaders(config),
      body: JSON.stringify({
        model: config.model,
        messages: [{ role: 'user', content: 'ping' }],
        max_tokens: 1,
        stream: false,
      }),
      signal: controller.signal,
    });
  } catch {
    throw new LlmError('network');
  } finally {
    clearTimeout(timer);
  }
  if (!resp.ok) {
    const detail = await resp.text().catch(() => '');
    throw new LlmError('http', { status: resp.status, detail });
  }
}
