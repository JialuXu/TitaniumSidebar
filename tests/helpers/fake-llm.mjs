// tests/helpers/fake-llm.mjs —— 假的 OpenAI 兼容接口
//
// core/llm-client.js 只依赖标准 fetch。这里用 node:test 的 mock 临时替换 globalThis.fetch，
// 按给定分片吐出 SSE 流，从而在不连任何真实接口的前提下覆盖流式解析的各种收尾方式。
// mock 由 node:test 在每个测试结束时自动还原。

const encoder = new TextEncoder();

/** 一条 SSE data 行（对象自动 JSON 序列化），不含结尾换行 */
export function data(payload) {
  return `data: ${typeof payload === 'string' ? payload : JSON.stringify(payload)}`;
}

/** 正文增量块 */
export function deltaChunk(content, finishReason = null) {
  return { choices: [{ index: 0, delta: { content }, finish_reason: finishReason }] };
}

/** 工具调用分片块：frags 形如 [{ index, id?, name?, arguments? }] */
export function toolChunk(frags, finishReason = null) {
  return {
    choices: [{
      index: 0,
      delta: {
        tool_calls: frags.map((f) => ({
          index: f.index,
          ...(f.id ? { id: f.id, type: 'function' } : {}),
          function: {
            ...(f.name ? { name: f.name } : {}),
            ...(f.arguments !== undefined ? { arguments: f.arguments } : {}),
          },
        })),
      },
      finish_reason: finishReason,
    }],
  };
}

/**
 * 把若干段文本包成流式 Response。每个元素是一次 reader.read() 读到的内容，
 * 可以刻意在一行中间切开，验证跨 chunk 的半行拼接。
 */
export function streamResponse(chunks, { status = 200 } = {}) {
  const body = new ReadableStream({
    start(controller) {
      for (const c of chunks) controller.enqueue(encoder.encode(c));
      controller.close();
    },
  });
  return new Response(body, { status, headers: { 'Content-Type': 'text/event-stream' } });
}

/** 由若干 SSE 行拼出标准的流（每行后跟空行），作为单个 chunk 返回 */
export function sseResponse(lines) {
  return streamResponse([lines.map((l) => l + '\n\n').join('')]);
}

/**
 * 替换 fetch。handler 收到 (url, init)，返回 Response 或抛错；
 * 返回的 calls 数组记录每次请求的 url 与解析后的请求体，供断言请求形状。
 * @param {import('node:test').TestContext} t
 */
export function mockFetch(t, handler) {
  const calls = [];
  t.mock.method(globalThis, 'fetch', async (url, init = {}) => {
    calls.push({ url: String(url), init, body: init.body ? JSON.parse(init.body) : null });
    return handler(url, init);
  });
  return calls;
}

/** 跑完一个异步生成器，收集全部事件；抛错时连同已收到的事件一起返回 */
export async function drain(gen) {
  const events = [];
  try {
    for await (const e of gen) events.push(e);
    return { events, error: null };
  } catch (error) {
    return { events, error };
  }
}

export const CONFIG = Object.freeze({ baseUrl: 'https://llm.example.test/v1', model: 'test-model', apiKey: 'sk-test' });
