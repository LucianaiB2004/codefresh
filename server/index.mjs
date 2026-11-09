// CodeFresh 本地安全桥接服务
// - 只监听 127.0.0.1（loopback），同源提供静态页面与 /api
// - 上游只允许两个硬编码的官方 WSA 域名 + GitHub 官方 API，不做任意 URL 代理
// - 凭据只在单次请求内使用，不落盘、不写日志、不回显
import http from 'node:http';
import { readFile, stat } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { runSearch, testConnection, METHODS } from '../src/providers/index.mjs';
import { createOpenClawClient } from '../src/openclaw.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PUBLIC_DIR = path.join(ROOT, 'public');
const SRC_DIR = path.join(ROOT, 'src');
// 浏览器可加载的通用模块（不含任何签名 / 密钥逻辑）
export const LIB_ALLOW = new Set([
  'credentials.mjs', 'openclaw.mjs', 'tutorial-check.mjs', 'tutorial-discover.mjs', 'providers/wsa-response.mjs',
]);
const MIME = {
  '.html': 'text/html; charset=utf-8', '.css': 'text/css; charset=utf-8', '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8', '.json': 'application/json; charset=utf-8', '.webp': 'image/webp',
  '.png': 'image/png', '.svg': 'image/svg+xml', '.ico': 'image/x-icon', '.txt': 'text/plain; charset=utf-8',
};
const MAX_BODY = 16 * 1024;
const MAX_INFLIGHT = 4;

export function createServer({ env = process.env, fetchImpl = fetch, port = 4173 } = {}) {
  const allowEnv = env.CODEFRESH_ALLOW_ENV_CREDENTIALS === '1';
  const envCreds = {
    'api-key': allowEnv && env.TENCENTCLOUD_WSA_APIKEY ? { apiKey: env.TENCENTCLOUD_WSA_APIKEY } : null,
    aksk: allowEnv && env.TENCENTCLOUD_SECRET_ID && env.TENCENTCLOUD_SECRET_KEY ? { secretId: env.TENCENTCLOUD_SECRET_ID, secretKey: env.TENCENTCLOUD_SECRET_KEY } : null,
  };
  const openclaw = createOpenClawClient({ fetchImpl });
  let inflight = 0;
  const allowedHosts = new Set([`127.0.0.1:${port}`, `localhost:${port}`]);

  function send(res, status, obj, extra = {}) {
    const body = JSON.stringify(obj);
    res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', ...securityHeaders(), ...extra });
    res.end(body);
  }

  function readJson(req) {
    return new Promise((resolve, reject) => {
      const ct = String(req.headers['content-type'] || '');
      if (!ct.startsWith('application/json')) { reject(Object.assign(new Error('需要 application/json'), { status: 415 })); return; }
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

  function resolveCreds(method, c) {
    if (c && c.source === 'env') return envCreds[method];
    if (!c || typeof c !== 'object') return null;
    if (method === 'api-key') return { apiKey: typeof c.apiKey === 'string' ? c.apiKey : '' };
    return { secretId: typeof c.secretId === 'string' ? c.secretId : '', secretKey: typeof c.secretKey === 'string' ? c.secretKey : '' };
  }

  async function withSlot(res, fn) {
    if (inflight >= MAX_INFLIGHT) { send(res, 503, { ok: false, code: 'Busy', message: '本地服务繁忙，请稍后再试' }); return; }
    inflight++;
    try { await fn(); } finally { inflight--; }
  }

  async function handleApi(req, res, url) {
    // 防 CSRF / DNS rebinding：Host 必须是 loopback，跨源请求一律拒绝
    if (!allowedHosts.has(String(req.headers.host || ''))) return send(res, 403, { ok: false, code: 'ForbiddenHost', message: '仅允许本机访问' });
    const origin = req.headers.origin;
    if (origin && !allowedHosts.has(origin.replace(/^https?:\/\//, ''))) return send(res, 403, { ok: false, code: 'ForbiddenOrigin', message: '拒绝跨源请求' });

    if (req.method === 'GET' && url.pathname === '/api/health') {
      return send(res, 200, { ok: true, mode: 'local', envCredentials: { 'api-key': !!envCreds['api-key'], aksk: !!envCreds.aksk } });
    }
    if (req.method === 'GET' && url.pathname === '/api/openclaw/releases') {
      const r = await openclaw.getReleases({ force: url.searchParams.get('force') === '1' });
      return send(res, r.ok ? 200 : 502, r);
    }
    if (req.method === 'GET' && url.pathname === '/api/openclaw/changelog') {
      const r = await openclaw.getChangelog(url.searchParams.get('tag') || '');
      return send(res, 200, r);
    }
    if (req.method === 'POST' && (url.pathname === '/api/connection-test' || url.pathname === '/api/search')) {
      let body;
      try { body = await readJson(req); } catch (e) { return send(res, e.status || 400, { ok: false, code: 'BadRequest', message: e.message }); }
      const method = body.method;
      if (!METHODS.includes(method)) return send(res, 400, { ok: false, code: 'InvalidMethod', message: '未知的鉴权方式' });
      const creds = resolveCreds(method, body.credentials);
      if (!creds) return send(res, 400, { ok: false, code: 'MissingCredentials', message: '未提供凭据（或未允许使用本机环境变量）' });
      return withSlot(res, async () => {
        if (url.pathname === '/api/connection-test') {
          const r = await testConnection(method, creds, { fetchImpl });
          return send(res, 200, r);
        }
        const r = await runSearch(method, creds, { query: body.query, site: body.site || null, freshness: body.freshness || null }, { fetchImpl });
        const out = r.ok
          ? { ok: true, provider: method, requestId: r.requestId, query: r.query, version: r.version, msg: r.msg, items: r.items, skipped: r.skipped, searchedAt: new Date().toISOString() }
          : { ok: false, provider: method, code: r.error.code, message: r.error.message, requestId: r.requestId || null };
        return send(res, 200, out);
      });
    }
    return send(res, 404, { ok: false, code: 'NotFound', message: '接口不存在' });
  }

  async function serveStatic(req, res, url) {
    if (req.method !== 'GET' && req.method !== 'HEAD') { res.writeHead(405); res.end(); return; }
    let pathname = decodeURIComponent(url.pathname);
    let file;
    if (pathname.startsWith('/lib/')) {
      const rel = pathname.slice(5);
      if (!LIB_ALLOW.has(rel)) { res.writeHead(404); res.end('Not found'); return; }
      file = path.join(SRC_DIR, rel);
    } else {
      if (pathname.endsWith('/')) pathname += 'index.html';
      file = path.normalize(path.join(PUBLIC_DIR, pathname));
      if (!file.startsWith(PUBLIC_DIR + path.sep)) { res.writeHead(403); res.end(); return; }
    }
    try {
      const st = await stat(file);
      if (!st.isFile()) throw new Error('nf');
      const data = await readFile(file);
      res.writeHead(200, { 'Content-Type': MIME[path.extname(file)] || 'application/octet-stream', 'Cache-Control': 'no-cache', ...securityHeaders() });
      res.end(req.method === 'HEAD' ? undefined : data);
    } catch {
      res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' }); res.end('Not found');
    }
  }

  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, `http://127.0.0.1:${port}`);
    const started = Date.now();
    try {
      if (url.pathname.startsWith('/api/')) await handleApi(req, res, url);
      else await serveStatic(req, res, url);
    } catch {
      if (!res.headersSent) send(res, 500, { ok: false, code: 'InternalError', message: '本地服务内部错误' });
    }
    if (env.CODEFRESH_QUIET !== '1') console.log(`${req.method} ${url.pathname} ${res.statusCode} ${Date.now() - started}ms`); // 只记录路径，不记录 query / body
  });
  server.requestTimeout = 30000;
  server.headersTimeout = 10000;
  return server;
}

export function securityHeaders() {
  return {
    'X-Content-Type-Options': 'nosniff',
    'Referrer-Policy': 'no-referrer',
    'X-Frame-Options': 'DENY',
    'Content-Security-Policy': "default-src 'self'; img-src 'self' data: https:; connect-src 'self' https://api.github.com https://raw.githubusercontent.com; style-src 'self' 'unsafe-inline'; script-src 'self'; object-src 'none'; base-uri 'none'; frame-ancestors 'none'",
  };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const port = Number(process.env.PORT) || 4173;
  const server = createServer({ port });
  server.listen(port, '127.0.0.1', () => {
    console.log(`CodeFresh 本地完整模式已启动：http://127.0.0.1:${port}`);
    console.log('凭据只保存在浏览器内存，本服务不落盘、不记录。按 Ctrl+C 退出。');
  });
}
