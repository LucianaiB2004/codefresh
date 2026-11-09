// 统一入口：按 method 调用对应方式；限流最多退避重试一次；认证/未开通/参数错误不重试
import { buildSearchBody, CONNECTION_TEST_QUERY } from './request.mjs';
import { searchWithApiKey } from './wsa-api-key.mjs';
import { searchWithAkSk } from './wsa-aksk.mjs';

export const METHODS = ['api-key', 'aksk'];
export const METHOD_LABEL = { 'api-key': '服务 API Key', aksk: '腾讯云标准方式' };
export { CONNECTION_TEST_QUERY };

export async function runSearch(method, credentials, params, opts = {}) {
  const { sleep = (ms) => new Promise((r) => setTimeout(r, ms)), retryDelayMs = 1200 } = opts;
  if (!METHODS.includes(method)) {
    return { ok: false, error: { code: 'InvalidMethod', message: '未知的鉴权方式' }, requestId: null, items: [] };
  }
  let body;
  try { body = buildSearchBody(params); } catch (e) {
    return { ok: false, error: { code: e.code || 'InvalidParameter', message: e.message }, requestId: null, items: [] };
  }
  const call = () => (method === 'api-key' ? searchWithApiKey(credentials || {}, body, opts) : searchWithAkSk(credentials || {}, body, opts));
  for (let attempt = 0; attempt < 2; attempt++) {
    let result;
    try { result = await call(); } catch (e) { result = fromException(e); }
    if (!result.ok && result.error?.code === 'RequestLimitExceeded' && attempt === 0) {
      await sleep(retryDelayMs);
      continue;
    }
    return { ...result, provider: method };
  }
  return { ok: false, error: { code: 'RequestLimitExceeded', message: '请求过于频繁，请稍后再试' }, requestId: null, items: [], provider: method };
}

export function fromException(e) {
  if (e?.code === 'MissingCredentials') return { ok: false, error: { code: 'MissingCredentials', message: e.message }, requestId: null, items: [] };
  if (e?.name === 'TimeoutError' || e?.name === 'AbortError') return { ok: false, error: { code: 'Timeout', message: '连接元宝搜索超时（15 秒）' }, requestId: null, items: [] };
  return { ok: false, error: { code: 'NetworkError', message: '无法连接元宝搜索服务，请检查网络' }, requestId: null, items: [] };
}

export async function testConnection(method, credentials, opts = {}) {
  const r = await runSearch(method, credentials, { query: CONNECTION_TEST_QUERY }, opts);
  if (r.ok) {
    return { ok: true, method, requestId: r.requestId, version: r.version || null, message: `已连接（${METHOD_LABEL[method]}）` };
  }
  return { ok: false, method, code: r.error.code, message: r.error.message, requestId: r.requestId || null };
}
