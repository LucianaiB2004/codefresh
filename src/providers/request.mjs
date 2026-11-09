// SearchPro 请求体构造与参数校验（只传 Query + 可选 Site / Freshness，不传极速版不支持的参数）
export const MAX_QUERY = 120;

export function validateFreshness(f) {
  if (f == null || f === '') return null;
  if (typeof f !== 'string') throw paramError('Freshness 格式错误');
  const s = f.trim();
  if (/^d([1-9]|[12]\d|30)$/.test(s) || /^m([1-9]|1[0-2])$/.test(s) || /^y[1-5]$/.test(s)) return s;
  throw paramError('Freshness 只支持 d1–d30、m1–m12、y1–y5');
}

export function validateSite(site) {
  if (site == null || site === '') return null;
  if (typeof site !== 'string') throw paramError('Site 格式错误');
  const s = site.trim().toLowerCase();
  const domain = /^(?:[a-z0-9-]+\.)+[a-z]{2,}$/;
  if (domain.test(s)) return s;
  if (s.startsWith('exclude:')) {
    const parts = s.slice(8).split('|');
    if (parts.length >= 1 && parts.length <= 5 && parts.every((p) => domain.test(p))) return s;
  }
  throw paramError('Site 只能是单个域名，或 exclude:a.com|b.com（最多 5 个）');
}

export function buildSearchBody({ query, site = null, freshness = null }) {
  if (typeof query !== 'string' || !query.trim()) throw paramError('搜索词不能为空');
  const q = query.replace(/\s+/g, ' ').trim().slice(0, MAX_QUERY);
  const body = { Query: q };
  const s = validateSite(site); if (s) body.Site = s;
  const f = validateFreshness(freshness); if (f) body.Freshness = f;
  return body;
}

export function paramError(message) {
  const e = new Error(message); e.code = 'InvalidParameter'; e.local = true; return e;
}
