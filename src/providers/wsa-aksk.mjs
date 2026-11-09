// 方式 B：腾讯云标准 SecretId + SecretKey，TC3-HMAC-SHA256 签名（Node 内置 crypto，无 SDK）
// 依据：https://cloud.tencent.com/document/api/213/30654（签名方法 v3）
import { createHash, createHmac } from 'node:crypto';
import { parseSearchProResponse } from './wsa-response.mjs';

export const AKSK_HOST = 'wsa.tencentcloudapi.com';
export const AKSK_SERVICE = 'wsa';
export const AKSK_ACTION = 'SearchPro';
export const AKSK_VERSION = '2025-05-08';
const CT = 'application/json; charset=utf-8';

const sha256hex = (s) => createHash('sha256').update(s, 'utf8').digest('hex');
const hmac = (key, msg, enc) => createHmac('sha256', key).update(msg, 'utf8').digest(enc);

export function utcDate(timestamp) {
  return new Date(timestamp * 1000).toISOString().slice(0, 10);
}

// 纯函数：给定参数计算签名（便于用官方样例校验）
export function tc3Sign({ secretId, secretKey, service, host, action, payload, timestamp, contentType = CT }) {
  const date = utcDate(timestamp);
  const signedHeaders = 'content-type;host;x-tc-action';
  const canonicalHeaders = `content-type:${contentType}\nhost:${host}\nx-tc-action:${action.toLowerCase()}\n`;
  const hashedPayload = sha256hex(payload);
  const canonicalRequest = ['POST', '/', '', canonicalHeaders, signedHeaders, hashedPayload].join('\n');
  const credentialScope = `${date}/${service}/tc3_request`;
  const hashedCanonicalRequest = sha256hex(canonicalRequest);
  const stringToSign = ['TC3-HMAC-SHA256', String(timestamp), credentialScope, hashedCanonicalRequest].join('\n');
  const kDate = hmac('TC3' + secretKey, date);
  const kService = hmac(kDate, service);
  const kSigning = hmac(kService, 'tc3_request');
  const signature = hmac(kSigning, stringToSign, 'hex');
  return {
    hashedPayload,
    hashedCanonicalRequest,
    secretDateHex: kDate.toString('hex'),
    signature,
    authorization: `TC3-HMAC-SHA256 Credential=${secretId}/${credentialScope}, SignedHeaders=${signedHeaders}, Signature=${signature}`,
  };
}

export function buildAkSkRequest({ secretId, secretKey }, body, { now = () => Date.now() } = {}) {
  if (typeof secretId !== 'string' || !secretId.trim() || typeof secretKey !== 'string' || !secretKey.trim()) {
    const e = new Error('SecretId 与 SecretKey 需同时填写'); e.code = 'MissingCredentials'; throw e;
  }
  if (/[\r\n\s]/.test(secretId.trim()) || /[\r\n]/.test(secretKey)) {
    const e = new Error('密钥含非法字符'); e.code = 'MissingCredentials'; throw e;
  }
  const payload = JSON.stringify(body);
  const timestamp = Math.floor(now() / 1000);
  const { authorization } = tc3Sign({
    secretId: secretId.trim(), secretKey: secretKey.trim(), service: AKSK_SERVICE, host: AKSK_HOST,
    action: AKSK_ACTION, payload, timestamp,
  });
  return {
    url: `https://${AKSK_HOST}/`,
    init: {
      method: 'POST',
      headers: {
        Authorization: authorization,
        'Content-Type': CT,
        Host: AKSK_HOST,
        'X-TC-Action': AKSK_ACTION,
        'X-TC-Version': AKSK_VERSION,
        'X-TC-Timestamp': String(timestamp),
      },
      body: payload,
      redirect: 'error',
    },
  };
}

export async function searchWithAkSk(creds, body, { fetchImpl = fetch, timeoutMs = 15000, now } = {}) {
  const { url, init } = buildAkSkRequest(creds, body, { now });
  const res = await fetchImpl(url, { ...init, signal: AbortSignal.timeout(timeoutMs) });
  let json = null;
  try { json = await res.json(); } catch { json = null; }
  return parseSearchProResponse(json, { httpStatus: res.status });
}
