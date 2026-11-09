// 元宝搜索 SearchPro 响应解析与归一化（浏览器 / Node 通用，无依赖）
// 关键约束：Response.Pages 是「JSON 字符串数组」，需逐条 JSON.parse，坏条目安全跳过；
// HTTP 200 也必须检查 Response.Error；缺失字段一律为 null，绝不补假数据。

export const KNOWN_ERRORS = {
  UnauthorizedOperation: '认证失败：服务 API Key 或密钥无效 / 无权限',
  ResourceNotFound: '元宝搜索服务未开通',
  ResourceUnavailable: '服务不可用或账户欠费',
  InvalidParameter: '请求参数错误',
  RequestLimitExceeded: '请求过于频繁，请稍后再试',
  InternalError: '腾讯云内部错误，请稍后再试',
  'AuthFailure.SignatureFailure': '签名错误：SecretKey 不正确或签名内容不一致',
  'AuthFailure.SecretIdNotFound': 'SecretId 不存在或已被禁用',
  'AuthFailure.SignatureExpire': '签名过期：请校准本机时间',
  'AuthFailure.InvalidSecretId': 'SecretId 非法（不是云 API 密钥）',
  'AuthFailure.UnauthorizedOperation': '密钥无权调用元宝搜索',
};

// 不应自动重试的错误（认证、未开通、参数）
export const NON_RETRYABLE = new Set([
  'UnauthorizedOperation', 'ResourceNotFound', 'ResourceUnavailable', 'InvalidParameter',
]);

export function isAuthError(code) {
  return typeof code === 'string' && (code === 'UnauthorizedOperation' || code.startsWith('AuthFailure'));
}

export function safeUrl(raw) {
  if (typeof raw !== 'string' || !raw.trim()) return null;
  try {
    const u = new URL(raw.trim());
    if (u.protocol !== 'https:' && u.protocol !== 'http:') return null;
    return u.toString();
  } catch { return null; }
}

export function hostOf(url) {
  try { return new URL(url).hostname.toLowerCase().replace(/^www\./, ''); } catch { return null; }
}

export function isCsdnUrl(url) {
  const h = hostOf(url);
  return !!h && (h === 'csdn.net' || h.endsWith('.csdn.net'));
}

// 规范化 URL 用于去重：去掉 hash、utm_* 跟踪参数、末尾斜杠，host 小写
export function normalizeUrl(url) {
  try {
    const u = new URL(url);
    u.hash = '';
    for (const k of [...u.searchParams.keys()]) {
      if (/^utm_/i.test(k) || k === 'spm' || k === 'from') u.searchParams.delete(k);
    }
    u.hostname = u.hostname.toLowerCase().replace(/^www\./, '');
    let s = u.toString();
    if (s.endsWith('/') && u.pathname !== '/') s = s.slice(0, -1);
    if (u.pathname === '/' && !u.search) s = s.replace(/\/$/, '');
    return s.replace(/^http:/, 'https:');
  } catch { return null; }
}

// 「2026/10/06 00:00:00」「2026-10-06」→ 2026-10-06；空字符串 / 无法识别 → null
export function normalizeDate(raw) {
  if (typeof raw !== 'string' || !raw.trim()) return null;
  const m = raw.trim().match(/^(\d{4})[\/-](\d{1,2})[\/-](\d{1,2})/);
  if (!m) return null;
  const [y, mo, d] = [Number(m[1]), Number(m[2]), Number(m[3])];
  if (y < 1990 || mo < 1 || mo > 12 || d < 1 || d > 31) return null;
  return `${y}-${String(mo).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
}

function cleanText(s, max = 280) {
  if (typeof s !== 'string') return null;
  const t = s.replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim();
  if (!t) return null;
  return t.length > max ? t.slice(0, max - 1) + '…' : t;
}

export function normalizePage(page) {
  if (!page || typeof page !== 'object') return null;
  const url = safeUrl(page.url);
  if (!url) return null;
  const score = typeof page.score === 'number' && Number.isFinite(page.score) ? page.score : null;
  return {
    title: cleanText(page.title, 140) || hostOf(url),
    url,
    site: cleanText(page.site, 40),
    domain: hostOf(url),
    date: normalizeDate(page.date),
    summary: cleanText(page.passage) || cleanText(page.content),
    score,
    favicon: safeUrl(page.favicon),
    isCsdn: isCsdnUrl(url),
    isOfficial: false,
  };
}

// 解析一次 SearchPro 返回。httpStatus 可选；json 是整个响应体（含 Response）。
export function parseSearchProResponse(json, { httpStatus = 200 } = {}) {
  const resp = json && typeof json === 'object' ? (json.Response || null) : null;
  if (!resp) {
    return {
      ok: false,
      error: { code: httpStatus >= 400 ? `HTTP${httpStatus}` : 'BadResponse', message: `上游返回无法识别的数据（HTTP ${httpStatus}）` },
      requestId: null, items: [], skipped: 0,
    };
  }
  const requestId = typeof resp.RequestId === 'string' ? resp.RequestId : null;
  if (resp.Error) {
    const code = String(resp.Error.Code || 'UnknownError');
    return {
      ok: false,
      error: { code, message: KNOWN_ERRORS[code] || String(resp.Error.Message || '未知错误').slice(0, 200) },
      requestId, items: [], skipped: 0,
    };
  }
  if (httpStatus >= 400) {
    return { ok: false, error: { code: `HTTP${httpStatus}`, message: `上游 HTTP ${httpStatus}` }, requestId, items: [], skipped: 0 };
  }
  if (!Array.isArray(resp.Pages)) {
    return { ok: false, error: { code: 'BadResponse', message: '响应缺少 Pages 字段' }, requestId, items: [], skipped: 0 };
  }
  const items = [];
  let skipped = 0;
  for (const raw of resp.Pages) {
    let obj = null;
    try { obj = typeof raw === 'string' ? JSON.parse(raw) : raw; } catch { obj = null; }
    const item = normalizePage(obj);
    if (item) items.push(item); else skipped++;
  }
  return {
    ok: true,
    error: null,
    requestId,
    query: typeof resp.Query === 'string' ? resp.Query : null,
    version: typeof resp.Version === 'string' ? resp.Version : null,
    msg: typeof resp.Msg === 'string' && resp.Msg ? resp.Msg : null,
    items,
    skipped,
  };
}
