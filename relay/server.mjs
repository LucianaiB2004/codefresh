// CodeFresh 元宝搜索中转服务（relay）
// 用途：GitHub Pages 上的网页无法跨域直连元宝搜索（WSA 不返回 CORS 头），由本服务转发。
// 原则：
// - 零依赖，Node >= 18；本身只说 HTTP，HTTPS 由前面的 nginx 负责
// - 上游只允许两个硬编码的官方域名，不做任意 URL 代理
// - 请求体只保留 Query / Site / Freshness 三个字段（与本地模式一致）
// - 凭据只在单次请求内存中使用：不落盘、不写日志、不回显；日志只记 方法 路径 状态码 耗时
// - CORS 只放行 ALLOWED_ORIGINS；每 IP 限流；请求体 ≤ 16KB；上游超时 15 秒
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildSearchBody } from '../src/providers/request.mjs';
import { searchWithApiKey } from '../src/providers/wsa-api-key.mjs';
import { searchWithAkSk } from '../src/providers/wsa-aksk.mjs';
import { fromException } from '../src/providers/index.mjs';

export const DEFAULT_ORIGINS = ['https://lucianaib2004.github.io', 'http://127.0.0.1:4173'];
const MAX_BODY = 16 * 1024;

export function parseOrigins(v) {
  if (!v || !String(v).trim()) return new Set(DEFAULT_ORIGINS);
  return new Set(String(v).split(',').map((s) => s.trim().replace(/\/+$/, '')).filter(Boolean));
}

export function createRateLimiter({ limit = 20, windowMs = 60_000, now = () => Date.now() } = {}) {
  const hits = new Map(); // ip -> { start, count }
  return {
    take(ip) {
      const t = now();
      let h = hits.get(ip);
      if (!h || t - h.start >= windowMs) { h = { start: t, count: 0 }; hits.set(ip, h); }
      h.count++;
      if (hits.size > 10_000) for (const [k, v] of hits) if (t - v.start >= windowMs) hits.delete(k);
      return { ok: h.count <= limit, retryAfter: Math.ceil((h.start + windowMs - t) / 1000) };
    },
  };
}

export function createRelay({ env = process.env, fetchImpl = fetch, log = console.log, now } = {}) {
  const origins = parseOrigins(env.ALLOWED_ORIGINS);
  const trustProxy = env.TRUST_PROXY === '1';
  const limiter = createRateLimiter({ limit: Number(env.RATE_LIMIT_PER_MIN) || 20, now });
  const timeoutMs = Number(env.UPSTREAM_TIMEOUT_MS) || 15000;
  const quiet = env.RELAY_QUIET === '1';

  function cors(req) {
    const o = req.headers.origin;
    if (!o || !origins.has(o)) return {};
    return {
      'Access-Control-Allow-Origin': o,
      'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type',
      'Access-Control-Max-Age': '600',
      Vary: 'Origin',
    };
  }
  function send(req, res, status, obj, extra = {}) {
    res.writeHead(status, {
      'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store',
      'X-Content-Type-Options': 'nosniff', 'Referrer-Policy': 'no-referrer', ...cors(req), ...extra,
    });
    res.end(JSON.stringify(obj));
  }
  function clientIp(req) {
    if (trustProxy) {
      const real = req.headers['x-real-ip'];
      if (typeof real === 'string' && real) return real.trim();
      const xff = req.headers['x-forwarded-for'];
      if (typeof xff === 'string' && xff) { const parts = xff.split(','); return parts[parts.length - 1].trim(); }
    }
    return req.socket.remoteAddress || 'unknown';
  }
  function readJson(req) {
    return new Promise((resolve, reject) => {
      const ct = String(req.headers['content-type'] || '');
      if (!ct.startsWith('application/json')) { reject(Object.assign(new Error('需要 application/json'), { status: 415 })); return; }
      const declared = Number(req.headers['content-length']);
      if (declared > MAX_BODY) { reject(Object.assign(new Error('请求体过大'), { status: 413 })); req.resume(); return; }
      let size = 0; let tooBig = false; const chunks = [];
      req.on('data', (c) => {
        size += c.length;
        if (size > MAX_BODY) { if (!tooBig) { tooBig = true; reject(Object.assign(new Error('请求体过大'), { status: 413 })); } return; }
        chunks.push(c);
      });
      req.on('end', () => { if (tooBig) return; try { resolve(JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}')); } catch { reject(Object.assign(new Error('JSON 格式错误'), { status: 400 })); } });
      req.on('error', reject);
    });
  }
  const str = (v) => (typeof v === 'string' ? v : '');

  async function handle(req, res, url) {
    const origin = req.headers.origin;
    // 浏览器请求必须来自白名单来源；无 Origin（curl / 健康检查）只允许 GET /health
    if (origin && !origins.has(origin)) return send(req, res, 403, { ok: false, code: 'ForbiddenOrigin', message: '该来源不允许使用此中转服务' });
    if (req.method === 'OPTIONS') { res.writeHead(204, { ...cors(req), 'Cache-Control': 'no-store' }); res.end(); return; }
    if (req.method === 'GET' && (url.pathname === '/health' || url.pathname === '/api/health')) {
      return send(req, res, 200, { ok: true, mode: 'relay', service: 'codefresh-relay', stores: 'nothing' });
    }
    const isKey = url.pathname === '/api/wsa/search';
    const isTc3 = url.pathname === '/api/wsa/tc3';
    if (!isKey && !isTc3) return send(req, res, 404, { ok: false, code: 'NotFound', message: '接口不存在' });
    if (req.method !== 'POST') return send(req, res, 405, { ok: false, code: 'MethodNotAllowed', message: '只支持 POST' });
    if (!origin) return send(req, res, 403, { ok: false, code: 'ForbiddenOrigin', message: '缺少 Origin' });
    const rl = limiter.take(clientIp(req));
    if (!rl.ok) return send(req, res, 429, { ok: false, code: 'RelayRateLimited', message: `请求太频繁，请 ${rl.retryAfter} 秒后再试` }, { 'Retry-After': String(rl.retryAfter) });

    let input;
    try { input = await readJson(req); } catch (e) { return send(req, res, e.status || 400, { ok: false, code: 'BadRequest', message: e.message }); }
    if (!input || typeof input !== 'object') return send(req, res, 400, { ok: false, code: 'BadRequest', message: '请求格式错误' });
    let body;
    try {
      const b = input.body && typeof input.body === 'object' ? input.body : {};
      body = buildSearchBody({ query: b.Query, site: b.Site || null, freshness: b.Freshness || null });
    } catch (e) { return send(req, res, 400, { ok: false, code: e.code || 'InvalidParameter', message: e.message }); }

    let r;
    try {
      r = isKey
        ? await searchWithApiKey({ apiKey: str(input.apiKey) }, body, { fetchImpl, timeoutMs })
        : await searchWithAkSk({ secretId: str(input.secretId), secretKey: str(input.secretKey) }, body, { fetchImpl, timeoutMs, now });
    } catch (e) { r = fromException(e); }
    if (r.ok) {
      return send(req, res, 200, { ok: true, provider: isKey ? 'api-key' : 'aksk', requestId: r.requestId, query: r.query, version: r.version, msg: r.msg, items: r.items, skipped: r.skipped, searchedAt: new Date().toISOString() });
    }
    const status = r.error.code === 'MissingCredentials' ? 400 : 200;
    return send(req, res, status, { ok: false, provider: isKey ? 'api-key' : 'aksk', code: r.error.code, message: r.error.message, requestId: r.requestId || null });
  }

  const server = http.createServer(async (req, res) => {
    const started = Date.now();
    let pathname = '/';
    try {
      const url = new URL(req.url, 'http://relay.local');
      pathname = url.pathname;
      await handle(req, res, url);
    } catch {
      if (!res.headersSent) send(req, res, 500, { ok: false, code: 'InternalError', message: '中转服务内部错误' });
    }
    // 只记录方法、路径、状态码、耗时；不记录 IP、query、请求体或任何请求头
    if (!quiet) log(`${new Date().toISOString()} ${req.method} ${pathname} ${res.statusCode} ${Date.now() - started}ms`);
  });
  server.requestTimeout = 30000;
  server.headersTimeout = 10000;
  return server;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const port = Number(process.env.PORT) || 8787;
  const host = process.env.HOST || '127.0.0.1';
  const server = createRelay();
  server.listen(port, host, () => {
    console.log(`CodeFresh relay listening on http://${host}:${port}`);
    console.log(`Allowed origins: ${[...parseOrigins(process.env.ALLOWED_ORIGINS)].join(', ')}`);
  });
  const stop = () => server.close(() => process.exit(0));
  process.on('SIGTERM', stop); process.on('SIGINT', stop);
}
