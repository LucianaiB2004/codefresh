// 方式 A：元宝搜索服务 API Key（Bearer），固定官方上游，不接受任意 URL
import { parseSearchProResponse } from './wsa-response.mjs';

export const API_KEY_ENDPOINT = 'https://api.wsa.cloud.tencent.com/SearchPro';

export function buildApiKeyRequest(apiKey, body) {
  if (typeof apiKey !== 'string' || !apiKey.trim()) {
    const e = new Error('未填写服务 API Key'); e.code = 'MissingCredentials'; throw e;
  }
  if (/[\r\n]/.test(apiKey)) { const e = new Error('API Key 含非法字符'); e.code = 'MissingCredentials'; throw e; }
  return {
    url: API_KEY_ENDPOINT,
    init: {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json; charset=UTF-8',
        Authorization: `Bearer ${apiKey.trim()}`,
      },
      body: JSON.stringify(body),
      redirect: 'error',
    },
  };
}

export async function searchWithApiKey({ apiKey }, body, { fetchImpl = fetch, timeoutMs = 15000 } = {}) {
  const { url, init } = buildApiKeyRequest(apiKey, body);
  const res = await fetchImpl(url, { ...init, signal: AbortSignal.timeout(timeoutMs) });
  let json = null;
  try { json = await res.json(); } catch { json = null; }
  return parseSearchProResponse(json, { httpStatus: res.status });
}
